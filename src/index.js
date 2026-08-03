/**
 * index.js - Cloudflare Worker 진입점 (라우터)
 * ================================================
 * /api/* 는 이 워커가 직접 처리하고, 나머지 경로는 정적 자산(public/)을
 * 그대로 서빙합니다. 기존 FastAPI 버전(main.py)과 정확히 같은 경로/응답
 * 형태를 유지해서 프론트엔드(app.js)를 그대로 재사용합니다.
 */
import * as auth from "./auth.js";
import * as marketData from "./marketData.js";
import * as portfolio from "./portfolio.js";
import * as symbolsMod from "./symbols.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function errorJson(status, message) {
  return json({ detail: message }, status);
}

async function requireUser(request, env) {
  const token = auth.parseCookie(request, "session");
  const user = await auth.getUserBySession(env.DB, token);
  if (!user) throw { status: 401, message: "로그인이 필요합니다." };
  return user;
}

function isHttps(request) {
  return new URL(request.url).protocol === "https:";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleApi(request, env, url, pathname);
    } catch (err) {
      if (err && err.status) return errorJson(err.status, err.message);
      if (err instanceof auth.AuthError) return errorJson(400, err.message);
      if (err instanceof portfolio.InsufficientFundsError) return errorJson(400, err.message);
      if (err instanceof portfolio.InsufficientHoldingsError) return errorJson(400, err.message);
      if (err instanceof portfolio.QuoteUnavailableError) return errorJson(400, err.message);
      if (err instanceof portfolio.InvalidOrderError) return errorJson(400, err.message);
      if (err instanceof portfolio.OrderNotFoundError) return errorJson(404, err.message);
      console.error(err.stack || err);
      return errorJson(500, "서버 오류가 발생했습니다.");
    }
  },

  // Cloudflare Cron Trigger (wrangler.toml의 [triggers] crons) - 1분마다 대기 중인
  // 지정가 주문을 현재가와 비교해서 조건이 맞으면 체결합니다.
  async scheduled(event, env, ctx) {
    const result = await portfolio.checkAndFillPendingOrders(env.DB);
    console.log(`지정가 주문 점검: 대기 ${result.checked}건 중 ${result.filled}건 체결`);
  },
};

async function handleApi(request, env, url, pathname) {
  const method = request.method;
  const secure = isHttps(request);

  // ---------------- 인증 ----------------
  if (pathname === "/api/auth/signup" && method === "POST") {
    const { username, password } = await request.json();
    const { userId, token } = await auth.signup(env.DB, username, password);
    await portfolio.ensureAccount(env.DB, userId);
    return json({ id: userId, username: username.trim() }, 200, {
      "Set-Cookie": auth.sessionCookieHeader(token, { secure }),
    });
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const { username, password } = await request.json();
    const { userId, token } = await auth.login(env.DB, username, password);
    await portfolio.ensureAccount(env.DB, userId);
    return json({ id: userId, username: username.trim() }, 200, {
      "Set-Cookie": auth.sessionCookieHeader(token, { secure }),
    });
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = auth.parseCookie(request, "session");
    if (token) await auth.logout(env.DB, token);
    return json({ ok: true }, 200, {
      "Set-Cookie": auth.sessionCookieHeader(null, { clear: true, secure }),
    });
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    const user = await requireUser(request, env);
    return json(user);
  }

  // ---------------- 시세/검색 (로그인 불필요) ----------------
  if (pathname === "/api/catalog" && method === "GET") {
    return json({
      kr_stock: symbolsMod.KR_STOCKS,
      us_stock: symbolsMod.US_STOCKS,
      crypto: symbolsMod.CRYPTO,
    });
  }

  if (pathname === "/api/search" && method === "GET") {
    return json({ items: symbolsMod.search(url.searchParams.get("q") || "") });
  }

  let m;
  if ((m = pathname.match(/^\/api\/quote\/([^/]+)\/(.+)$/)) && method === "GET") {
    const [, assetType, symbol] = m;
    const quote = await marketData.getQuote(decodeURIComponent(symbol), assetType);
    if (!quote) return errorJson(404, `${symbol} 시세를 찾을 수 없습니다.`);
    quote.name = symbolsMod.lookupName(decodeURIComponent(symbol), assetType);
    return json(quote);
  }

  if (pathname === "/api/quotes" && method === "GET") {
    const assetType = url.searchParams.get("asset_type") || "";
    const catalog = symbolsMod.catalogFor(assetType);
    const quotes = await Promise.all(catalog.map(e => marketData.getQuote(e.symbol, assetType)));
    const items = [];
    catalog.forEach((entry, i) => {
      if (quotes[i]) { quotes[i].name = entry.name; items.push(quotes[i]); }
    });
    return json({ items });
  }

  if ((m = pathname.match(/^\/api\/candles\/([^/]+)\/(.+)$/)) && method === "GET") {
    const [, assetType, symbol] = m;
    const interval = url.searchParams.get("interval") || "5m";
    const candles = await marketData.getCandles(decodeURIComponent(symbol), assetType, interval);
    return json({ candles });
  }

  if (pathname === "/api/leaderboard" && method === "GET") {
    return json({ items: await portfolio.getLeaderboard(env.DB) });
  }

  // ---------------- 포트폴리오/거래 (로그인 필요) ----------------
  if (pathname === "/api/portfolio" && method === "GET") {
    const user = await requireUser(request, env);
    return json(await portfolio.getState(env.DB, user.id));
  }

  if (pathname === "/api/transactions" && method === "GET") {
    const user = await requireUser(request, env);
    return json({ items: await portfolio.getTransactions(env.DB, user.id) });
  }

  if (pathname === "/api/trade/buy" && method === "POST") {
    const user = await requireUser(request, env);
    const { symbol, asset_type, quantity } = await request.json();
    return json(await portfolio.buy(env.DB, user.id, symbol, asset_type, quantity));
  }

  if (pathname === "/api/trade/sell" && method === "POST") {
    const user = await requireUser(request, env);
    const { symbol, asset_type, quantity } = await request.json();
    return json(await portfolio.sell(env.DB, user.id, symbol, asset_type, quantity));
  }

  if (pathname === "/api/reset" && method === "POST") {
    const user = await requireUser(request, env);
    await portfolio.reset(env.DB, user.id);
    return json({ ok: true });
  }

  if (pathname === "/api/orders" && method === "GET") {
    const user = await requireUser(request, env);
    return json({ items: await portfolio.getPendingOrders(env.DB, user.id) });
  }

  if (pathname === "/api/orders/limit" && method === "POST") {
    const user = await requireUser(request, env);
    const { symbol, asset_type, side, quantity, limit_price_krw } = await request.json();
    return json(await portfolio.createLimitOrder(env.DB, user.id, symbol, asset_type, side, quantity, limit_price_krw));
  }

  if ((m = pathname.match(/^\/api\/orders\/(\d+)$/)) && method === "DELETE") {
    const user = await requireUser(request, env);
    return json(await portfolio.cancelOrder(env.DB, user.id, Number(m[1])));
  }

  return errorJson(404, "없는 경로입니다");
}
