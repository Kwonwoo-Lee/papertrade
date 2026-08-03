const $ = id => document.getElementById(id);
const fmtKRW = v => (v === null || v === undefined || isNaN(v)) ? "-" : "₩" + Math.round(v).toLocaleString();
const fmtPct = v => (v === null || v === undefined || isNaN(v)) ? "-" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
const clsFor = v => v > 0 ? "good" : (v < 0 ? "bad" : "");

const ASSET_LABEL = { kr_stock: "국내주식", us_stock: "미국주식", crypto: "코인" };

let currentTab = "kr_stock";
let currentDetail = null;
let detailReturnView = "account";
let currentSide = "buy";
let authMode = "login";
let me = null; // {id, username}

async function api(path, opts) {
  const r = await fetch(path, opts);
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.detail || r.statusText);
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escAttr(s) { return esc(s).replace(/'/g, "&#39;"); }
function fmtQty(q) { return Number(q).toLocaleString(undefined, { maximumFractionDigits: 6 }); }

/* ---------------- 인증 ---------------- */

async function checkAuth() {
  try {
    me = await api("/api/auth/me");
    showApp();
  } catch {
    me = null;
    showAuth();
  }
}

function showAuth() {
  $("authScreen").style.display = "flex";
  $("appScreen").style.display = "none";
}

function showApp() {
  $("authScreen").style.display = "none";
  $("appScreen").style.display = "block";
  $("whoami").textContent = `${me.username}님`;
  loadAllAccountData();
}

function setAuthMode(mode) {
  authMode = mode;
  $("loginTabBtn").classList.toggle("active", mode === "login");
  $("signupTabBtn").classList.toggle("active", mode === "signup");
  $("authSubmitBtn").textContent = mode === "login" ? "로그인" : "회원가입";
  $("authError").textContent = "";
}

async function submitAuth() {
  const username = $("authUsername").value.trim();
  const password = $("authPassword").value;
  const errEl = $("authError");
  errEl.textContent = "";
  if (!username || !password) { errEl.textContent = "아이디와 비밀번호를 입력해주세요."; return; }

  const btn = $("authSubmitBtn");
  btn.disabled = true;
  try {
    const path = authMode === "login" ? "/api/auth/login" : "/api/auth/signup";
    me = await api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    $("authPassword").value = "";
    showApp();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  me = null;
  $("authUsername").value = "";
  $("authPassword").value = "";
  showAuth();
}

/* ---------------- 포트폴리오 ---------------- */

async function loadPortfolio() {
  const p = await api("/api/portfolio");
  $("totalValue").textContent = fmtKRW(p.total_value_krw);
  const changeEl = $("totalChange");
  changeEl.textContent = `${p.total_pl_krw >= 0 ? "+" : ""}${fmtKRW(p.total_pl_krw)} (${fmtPct(p.total_pl_pct)})`;
  changeEl.className = "hero-change " + clsFor(p.total_pl_krw);
  $("cashValue").textContent = fmtKRW(p.cash_krw);
  $("initialValue").textContent = fmtKRW(p.initial_cash_krw);

  const list = $("holdingsList");
  if (!p.holdings.length) {
    list.innerHTML = '<p class="muted">아직 보유한 종목이 없습니다. 아래 "둘러보기"에서 종목을 선택해 매수해보세요.</p>';
  } else {
    list.innerHTML = p.holdings.map(h => `
      <div class="holding-row" onclick="openDetailFor('${h.symbol}','${h.asset_type}','${escAttr(h.name)}')">
        <div class="holding-main">
          <div class="holding-name">${esc(h.name)}</div>
          <div class="holding-sub">${esc(h.symbol)} · ${fmtQty(h.quantity)}주 · 평단 ${fmtKRW(h.avg_cost_krw)}</div>
        </div>
        <div class="holding-right">
          <div class="holding-value">${fmtKRW(h.market_value_krw)}</div>
          <div class="holding-pl ${clsFor(h.unrealized_pl_krw)}">${h.unrealized_pl_krw >= 0 ? "+" : ""}${fmtKRW(h.unrealized_pl_krw)} (${fmtPct(h.unrealized_pl_pct)})</div>
        </div>
      </div>
    `).join("");
  }
  return p;
}

async function loadDiscover(assetType) {
  const grid = $("discoverGrid");
  grid.innerHTML = '<p class="muted">불러오는 중...</p>';
  const d = await api(`/api/quotes?asset_type=${assetType}`);
  if (!d.items.length) {
    grid.innerHTML = '<p class="muted">시세를 불러오지 못했습니다.</p>';
    return;
  }
  grid.innerHTML = d.items.map(q => `
    <div class="discover-card" onclick="openDetailFor('${q.symbol}','${q.asset_type}','${escAttr(q.name)}')">
      <div class="name">${esc(q.name)}</div>
      <div class="symbol">${esc(q.symbol)}</div>
      <div class="price">${fmtKRW(q.price_krw)}</div>
      <div class="change ${clsFor(q.change_pct)}">${fmtPct(q.change_pct)}</div>
    </div>
  `).join("");
}

async function runSearch(q) {
  const grid = $("discoverGrid");
  if (!q.trim()) return loadDiscover(currentTab);
  grid.innerHTML = '<p class="muted">검색 중...</p>';
  const d = await api(`/api/search?q=${encodeURIComponent(q)}`);
  if (!d.items.length) {
    grid.innerHTML = '<p class="muted">검색 결과가 없습니다.</p>';
    return;
  }
  const withQuotes = await Promise.all(d.items.map(async item => {
    try { return await api(`/api/quote/${item.asset_type}/${encodeURIComponent(item.symbol)}`); }
    catch { return null; }
  }));
  const items = withQuotes.filter(Boolean);
  grid.innerHTML = items.map(q => `
    <div class="discover-card" onclick="openDetailFor('${q.symbol}','${q.asset_type}','${escAttr(q.name)}')">
      <div class="name">${esc(q.name)}</div>
      <div class="symbol">${esc(q.symbol)} · ${ASSET_LABEL[q.asset_type] || ""}</div>
      <div class="price">${fmtKRW(q.price_krw)}</div>
      <div class="change ${clsFor(q.change_pct)}">${fmtPct(q.change_pct)}</div>
    </div>
  `).join("");
}

async function loadTransactions() {
  const d = await api("/api/transactions");
  const box = $("txTable");
  if (!d.items.length) {
    box.innerHTML = '<tbody><tr><td class="muted">거래 내역이 없습니다.</td></tr></tbody>';
    return;
  }
  box.innerHTML =
    "<thead><tr><th>시각</th><th>종목</th><th>구분</th><th>수량</th><th>체결가</th><th>총액</th></tr></thead><tbody>" +
    d.items.map(t => `
      <tr>
        <td class="muted">${esc((t.created_at || "").slice(0, 19).replace("T", " "))}</td>
        <td>${esc(t.symbol)}</td>
        <td><span class="badge ${t.side}">${t.side === "buy" ? "매수" : "매도"}</span></td>
        <td>${fmtQty(t.quantity)}</td>
        <td>${fmtKRW(t.price_krw)}</td>
        <td>${fmtKRW(t.total_krw)}</td>
      </tr>
    `).join("") + "</tbody>";
}

/* ---------------- 랭킹 ---------------- */

async function loadLeaderboard() {
  const d = await api("/api/leaderboard");
  const box = $("rankTable");
  if (!d.items.length) {
    box.innerHTML = '<tbody><tr><td class="muted">아직 참가자가 없습니다.</td></tr></tbody>';
    return;
  }
  const rankBadge = rank => {
    const cls = rank === 1 ? "top1" : rank === 2 ? "top2" : rank === 3 ? "top3" : "";
    return `<span class="rank-badge ${cls}">${rank}</span>`;
  };
  box.innerHTML =
    "<thead><tr><th>순위</th><th>아이디</th><th>총 평가자산</th><th>수익률</th><th>보유종목수</th></tr></thead><tbody>" +
    d.items.map(r => `
      <tr class="${me && r.user_id === me.id ? "me" : ""}">
        <td>${rankBadge(r.rank)}</td>
        <td>${esc(r.username)}${me && r.user_id === me.id ? " (나)" : ""}</td>
        <td>${fmtKRW(r.total_value_krw)}</td>
        <td class="${clsFor(r.total_pl_pct)}">${fmtPct(r.total_pl_pct)}</td>
        <td class="muted">${r.holdings_count}</td>
      </tr>
    `).join("") + "</tbody>";
}

/* ---------------- 종목 상세 (차트 + 매매) ---------------- */

async function openDetailFor(symbol, assetType, name) {
  try {
    const [quote, portfolioState] = await Promise.all([
      api(`/api/quote/${assetType}/${encodeURIComponent(symbol)}`),
      api("/api/portfolio"),
    ]);
    const held = portfolioState.holdings.find(h => h.symbol === symbol && h.asset_type === assetType);
    currentDetail = { symbol, asset_type: assetType, name, price: quote.price_krw, changePct: quote.change_pct, ownedQty: held ? held.quantity : 0 };
    currentSide = "buy";
    $("detailName").textContent = name;
    $("detailSymbol").textContent = `${symbol} · ${ASSET_LABEL[assetType] || ""}`;
    $("detailPrice").textContent = fmtKRW(quote.price_krw);
    const changeEl = $("detailChange");
    changeEl.textContent = fmtPct(quote.change_pct);
    changeEl.className = "detail-change " + clsFor(quote.change_pct);
    $("detailQtyInput").value = 1;
    $("detailError").textContent = "";
    setDetailSide("buy");
    showDetailView();
    loadDetailChart("5m");
  } catch (e) {
    alert("시세를 불러오지 못했습니다: " + e.message);
  }
}

let currentChartInterval = "5m";
let detailChart = null;

function ensureDetailChart() {
  if (detailChart) return detailChart;
  detailChart = new CandleChart($("detailChartCanvas"));
  detailChart.onCrosshair = renderChartOHLC;
  return detailChart;
}

function renderChartOHLC(c) {
  const box = $("chartOHLC");
  if (!c) { box.innerHTML = ""; return; }
  const cls = c.c >= c.o ? "good" : "bad";
  box.innerHTML = `
    <span>시 <b class="${cls}">${fmtKRW(c.o)}</b></span>
    <span>고 <b class="${cls}">${fmtKRW(c.h)}</b></span>
    <span>저 <b class="${cls}">${fmtKRW(c.l)}</b></span>
    <span>종 <b class="${cls}">${fmtKRW(c.c)}</b></span>
  `;
}

async function loadDetailChart(interval, { resetView = true } = {}) {
  if (!currentDetail) return;
  currentChartInterval = interval;
  document.querySelectorAll("#detailChartRange .range-btn").forEach(b => b.classList.toggle("active", b.dataset.interval === interval));
  const symbol = currentDetail.symbol, assetType = currentDetail.asset_type;
  const canvas = $("detailChartCanvas");
  const empty = $("detailChartEmpty");
  try {
    const d = await api(`/api/candles/${assetType}/${encodeURIComponent(symbol)}?interval=${interval}`);
    if (!currentDetail || currentDetail.symbol !== symbol || currentDetail.asset_type !== assetType) return; // 상세 화면이 바뀐 뒤 응답이 늦게 온 경우 무시
    if (!d.candles || d.candles.length < 2) throw new Error("no data");
    const chart = ensureDetailChart();
    chart.setInterval(interval);
    chart.resize();
    chart.setData(d.candles, resetView);
    canvas.style.display = "block";
    empty.style.display = "none";
  } catch {
    canvas.style.display = "none";
    $("chartOHLC").innerHTML = "";
    empty.style.display = "block";
  }
}

function setDetailSide(side) {
  currentSide = side;
  document.querySelectorAll(".side-btn").forEach(b => b.classList.toggle("active", b.dataset.side === side));
  const ownedRow = $("detailOwnedRow");
  if (side === "sell") {
    ownedRow.style.display = "flex";
    $("detailOwnedQty").textContent = fmtQty(currentDetail.ownedQty);
  } else {
    ownedRow.style.display = "none";
  }
  updateDetailEstTotal();
}

function updateDetailEstTotal() {
  const qty = parseFloat($("detailQtyInput").value) || 0;
  $("detailEstTotal").textContent = currentDetail ? fmtKRW(currentDetail.price * qty) : "-";
}

async function submitDetailTrade() {
  if (!currentDetail) return;
  const qty = parseFloat($("detailQtyInput").value);
  const errEl = $("detailError");
  errEl.textContent = "";
  if (!qty || qty <= 0) { errEl.textContent = "올바른 수량을 입력해주세요."; return; }

  const btn = $("detailSubmitBtn");
  btn.disabled = true;
  try {
    await api(`/api/trade/${currentSide}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: currentDetail.symbol, asset_type: currentDetail.asset_type, quantity: qty }),
    });
    const portfolioState = await loadPortfolio();
    await loadTransactions();
    const held = portfolioState.holdings.find(h => h.symbol === currentDetail.symbol && h.asset_type === currentDetail.asset_type);
    currentDetail.ownedQty = held ? held.quantity : 0;
    setDetailSide(currentSide);
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function refreshDetailQuote() {
  if (!currentDetail) return;
  try {
    const quote = await api(`/api/quote/${currentDetail.asset_type}/${encodeURIComponent(currentDetail.symbol)}`);
    if (!currentDetail) return;
    currentDetail.price = quote.price_krw;
    $("detailPrice").textContent = fmtKRW(quote.price_krw);
    const changeEl = $("detailChange");
    changeEl.textContent = fmtPct(quote.change_pct);
    changeEl.className = "detail-change " + clsFor(quote.change_pct);
    updateDetailEstTotal();
  } catch {}
}

function showDetailView() {
  detailReturnView = $("rankingView").style.display !== "none" ? "ranking" : "account";
  $("accountView").style.display = "none";
  $("rankingView").style.display = "none";
  $("detailView").style.display = "block";
}

function closeDetail() {
  currentDetail = null;
  $("detailView").style.display = "none";
  switchMainView(detailReturnView);
}

function loadAllAccountData() {
  loadPortfolio();
  loadDiscover(currentTab);
  loadTransactions();
}

function switchMainView(view) {
  document.querySelectorAll("#mainNav .tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  $("detailView").style.display = "none";
  currentDetail = null;
  $("accountView").style.display = view === "account" ? "block" : "none";
  $("rankingView").style.display = view === "ranking" ? "block" : "none";
  if (view === "ranking") loadLeaderboard();
}

function init() {
  $("loginTabBtn").addEventListener("click", () => setAuthMode("login"));
  $("signupTabBtn").addEventListener("click", () => setAuthMode("signup"));
  $("authSubmitBtn").addEventListener("click", submitAuth);
  $("authPassword").addEventListener("keydown", e => { if (e.key === "Enter") submitAuth(); });
  $("logoutBtn").addEventListener("click", logout);

  document.querySelectorAll("#mainNav .tab").forEach(tab => {
    tab.addEventListener("click", () => switchMainView(tab.dataset.view));
  });

  document.querySelectorAll("#discoverTabs .tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#discoverTabs .tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentTab = tab.dataset.type;
      $("searchInput").value = "";
      loadDiscover(currentTab);
    });
  });

  let searchTimer;
  $("searchInput").addEventListener("input", e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 300);
  });

  document.querySelectorAll("#detailChartRange .range-btn").forEach(b => b.addEventListener("click", () => loadDetailChart(b.dataset.interval)));
  document.querySelectorAll(".side-btn").forEach(b => b.addEventListener("click", () => setDetailSide(b.dataset.side)));
  $("detailQtyInput").addEventListener("input", updateDetailEstTotal);
  $("detailSubmitBtn").addEventListener("click", submitDetailTrade);
  $("detailBack").addEventListener("click", closeDetail);

  $("resetBtn").addEventListener("click", async () => {
    if (!confirm("계좌를 초기 상태로 리셋할까요? 모든 보유 종목과 거래 내역이 사라집니다.")) return;
    await api("/api/reset", { method: "POST" });
    await Promise.all([loadPortfolio(), loadTransactions(), loadDiscover(currentTab)]);
  });

  checkAuth();

  setInterval(() => {
    if (!me) return;
    if (currentDetail) {
      refreshDetailQuote();
      loadDetailChart(currentChartInterval, { resetView: false });
    } else if ($("rankingView").style.display !== "none") {
      loadLeaderboard();
    } else {
      loadPortfolio();
      if (!$("searchInput").value.trim()) loadDiscover(currentTab);
    }
  }, 20000);
}

init();
