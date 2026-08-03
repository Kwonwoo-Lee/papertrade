/**
 * auth.js - 회원가입/로그인/세션 관리 (Cloudflare D1 + Web Crypto)
 * ===================================================================
 * Node의 crypto 모듈이나 외부 라이브러리 없이 Workers 런타임에 기본
 * 내장된 Web Crypto API(crypto.subtle)만으로 비밀번호를 PBKDF2로
 * 해시합니다. 세션은 D1에 저장하고 쿠키로 토큰을 내려주는 방식입니다.
 */

const SESSION_TTL_DAYS = 30;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;
const PBKDF2_ITERATIONS = 200_000;

export class AuthError extends Error {}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
  return `${toHex(salt)}$${toHex(bits)}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = (stored || "").split("$");
  if (!saltHex || !hashHex) return false;
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
  return timingSafeEqual(toHex(bits), hashHex);
}

function newToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function signup(db, username, password) {
  username = (username || "").trim();
  if (!USERNAME_RE.test(username)) {
    throw new AuthError("아이디는 영문/숫자/_/- 조합 3~20자여야 합니다.");
  }
  if (!password || password.length < 6) {
    throw new AuthError("비밀번호는 6자 이상이어야 합니다.");
  }

  const existing = await db.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
  if (existing) throw new AuthError("이미 사용 중인 아이디입니다.");

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const result = await db.prepare(
    "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)"
  ).bind(username, passwordHash, now).run();
  const userId = result.meta.last_row_id;

  const token = await createSession(db, userId);
  return { userId, username, token };
}

export async function login(db, username, password) {
  username = (username || "").trim();
  const row = await db.prepare("SELECT id, password_hash FROM users WHERE username = ?").bind(username).first();
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new AuthError("아이디 또는 비밀번호가 올바르지 않습니다.");
  }
  const token = await createSession(db, row.id);
  return { userId: row.id, username, token };
}

async function createSession(db, userId) {
  const token = newToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_DAYS * 86400_000);
  await db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(token, userId, now.toISOString(), expires.toISOString()).run();
  return token;
}

export async function logout(db, token) {
  if (!token) return;
  await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

export async function getUserBySession(db, token) {
  if (!token) return null;
  const row = await db.prepare(
    `SELECT s.user_id as id, s.expires_at as expiresAt, u.username as username
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row.expiresAt) < new Date()) {
    await logout(db, token);
    return null;
  }
  return { id: row.id, username: row.username };
}

export function parseCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export function sessionCookieHeader(token, { clear = false, secure = true } = {}) {
  // secure=false는 로컬 wrangler dev(http://localhost)처럼 HTTPS가 아닐 때만 씁니다.
  // 프로덕션(항상 https)에서는 반드시 secure=true로 호출해야 합니다.
  const maxAge = clear ? 0 : SESSION_TTL_DAYS * 86400;
  const value = clear ? "" : token;
  const secureFlag = secure ? " Secure;" : "";
  return `session=${value}; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=${maxAge}`;
}
