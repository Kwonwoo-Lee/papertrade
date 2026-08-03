/**
 * marketData.js - 국내주식/미국주식/코인 실시간(근접) 시세 통합 조회
 * ====================================================================
 * Cloudflare Workers는 Python(yfinance)을 못 돌리므로, yfinance가 내부적으로
 * 호출하는 것과 같은 Yahoo Finance 원시 차트 API를 fetch로 직접 호출합니다.
 * 실시간 현재가는 Python 버전과 동일하게 CoinGecko 공개 API를 씁니다.
 * 분봉 캔들차트는 CoinGecko 무료 API가 분 단위 캔들을 제공하지 않아서,
 * 코인도 Yahoo Finance의 -USD 티커(예: BTC-USD)를 통해 조회합니다.
 * 전부 KRW로 환산해서 반환합니다. 모듈 스코프의 간단한 TTL 캐시로
 * 같은 워커 인스턴스 안에서 반복 조회를 줄입니다(정확한 분산 캐시는
 * 아니지만, Python 버전의 in-memory 캐시와 동일한 수준의 최적화입니다).
 */
import { yahooTickerFor } from "./symbols.js";

const CACHE_TTL_MS = 15_000;
const CRYPTO_CACHE_TTL_MS = 30_000; // CoinGecko 무료 API는 요청 제한이 더 엄격함
const CANDLE_CACHE_TTL_MS = 20_000;
const cache = new Map(); // key -> { at, value }

const BROWSER_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; papertrade/1.0)" };

// 화면에 노출하는 봉 종류 -> 야후 파이낸스 interval/range.
// 야후는 1m은 최근 7일, 그 외 분봉은 최근 60일까지만 지원해서 range를 짧게 잡습니다.
// 3분봉은 야후가 직접 지원하지 않아 1분봉을 3개씩 묶어서(aggregate) 만듭니다.
const CANDLE_INTERVALS = {
  "1m": { yahooInterval: "1m", range: "1d", aggregate: 1 },
  "3m": { yahooInterval: "1m", range: "1d", aggregate: 3 },
  "5m": { yahooInterval: "5m", range: "5d", aggregate: 1 },
  "15m": { yahooInterval: "15m", range: "5d", aggregate: 1 },
  "30m": { yahooInterval: "30m", range: "1mo", aggregate: 1 },
  "60m": { yahooInterval: "60m", range: "3mo", aggregate: 1 },
  "1d": { yahooInterval: "1d", range: "1y", aggregate: 1 },
};

async function cached(key, ttlMs, fetchFn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;
  try {
    const value = await fetchFn();
    cache.set(key, { at: now, value });
    return value;
  } catch (err) {
    // 일시적 실패(요청 제한 등) 시, 하나의 시세 실패로 전체 응답이 죽지
    // 않도록 오래된 캐시라도 있으면 그걸 반환합니다.
    if (hit) return hit.value;
    console.error(`quote fetch failed for ${key}:`, err.message);
    // 실패도 잠깐 캐싱해서, 같은 요청 제한(429) 구간에서 재시도가 몰려
    // 제한이 더 길어지는 걸 막습니다.
    cache.set(key, { at: now, value: null });
    return null;
  }
}

async function getUsdKrwRate() {
  return cached("fx:usdkrw", 60_000, async () => {
    const raw = await fetchYahooChart("KRW=X", "5d");
    if (!raw) return 1400.0; // 조회 실패 시 대략치로 폴백
    return raw.price;
  });
}

async function fetchYahooChart(symbol, range = "5d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance: no data for ${symbol}`);

  const closes = (result.indicators?.quote?.[0]?.close || []).filter(c => c !== null && c !== undefined);
  const timestamps = result.timestamp || [];
  const price = result.meta.regularMarketPrice ?? closes[closes.length - 1];
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : result.meta.chartPreviousClose;
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  return {
    price,
    currency: result.meta.currency,
    changePct: Math.round(changePct * 100) / 100,
    dayHigh: result.meta.regularMarketDayHigh ?? null,
    dayLow: result.meta.regularMarketDayLow ?? null,
    volume: result.meta.regularMarketVolume ?? null,
    prevClose: result.meta.chartPreviousClose ?? prevClose ?? null,
    week52High: result.meta.fiftyTwoWeekHigh ?? null,
    week52Low: result.meta.fiftyTwoWeekLow ?? null,
    points: timestamps.map((t, i) => ({ t, close: result.indicators.quote[0].close[i] }))
      .filter(p => p.close !== null && p.close !== undefined),
  };
}

async function stockQuote(ticker) {
  return cached(`quote:${ticker}`, CACHE_TTL_MS, async () => {
    const raw = await fetchYahooChart(ticker, "5d");
    if (!raw) return null;
    return {
      priceNative: raw.price, currency: raw.currency, changePct: raw.changePct,
      dayHigh: raw.dayHigh, dayLow: raw.dayLow, volume: raw.volume,
      prevClose: raw.prevClose, week52High: raw.week52High, week52Low: raw.week52Low,
    };
  });
}

// CoinGecko 무료 API는 당일 고가/저가/거래량/52주 범위를 안정적으로 안 줘서,
// 코인도 야후의 -USD 티커에서 이 통계만 보조로 가져옵니다 (실시간가/등락률은 계속 CoinGecko 사용).
async function cryptoDayStats(coinId) {
  return cached(`daystats:crypto:${coinId}`, CACHE_TTL_MS, async () => {
    const raw = await fetchYahooChart(yahooTickerFor(coinId, "crypto"), "5d");
    if (!raw) return null;
    return {
      dayHigh: raw.dayHigh, dayLow: raw.dayLow, volume: raw.volume,
      prevClose: raw.prevClose, week52High: raw.week52High, week52Low: raw.week52Low,
    };
  });
}

async function cryptoQuote(coinId) {
  return cached(`quote:crypto:${coinId}`, CRYPTO_CACHE_TTL_MS, async () => {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) throw new Error(`CoinGecko ${res.status} for ${coinId}`);
    const data = await res.json();
    const entry = data[coinId];
    if (!entry) return null;
    return {
      priceNative: entry.usd,
      currency: "USD",
      changePct: Math.round((entry.usd_24h_change ?? 0) * 100) / 100,
    };
  });
}

function toKrw(nativeValue, scale) {
  return nativeValue == null ? null : Math.round(nativeValue * scale * 100) / 100;
}

/** assetType: 'kr_stock' | 'us_stock' | 'crypto'. 반환 price는 항상 KRW로 환산됩니다. */
export async function getQuote(symbol, assetType) {
  const raw = assetType === "crypto" ? await cryptoQuote(symbol) : await stockQuote(symbol);
  if (!raw) return null;
  const fx = await getUsdKrwRate();
  const scale = raw.currency === "USD" ? fx : 1;
  const priceKrw = raw.priceNative * scale;
  const stats = assetType === "crypto" ? await cryptoDayStats(symbol) : raw;
  // 기존 파이썬 API와 동일한 snake_case 키로 반환 - 프론트엔드(app.js)를 그대로 재사용하기 위함
  return {
    symbol,
    asset_type: assetType,
    price_krw: Math.round(priceKrw * 100) / 100,
    price_native: raw.priceNative,
    currency: raw.currency,
    change_pct: raw.changePct,
    day_high_krw: toKrw(stats?.dayHigh, scale),
    day_low_krw: toKrw(stats?.dayLow, scale),
    prev_close_krw: toKrw(stats?.prevClose, scale),
    volume: stats?.volume ?? null,
    week52_high_krw: toKrw(stats?.week52High, scale),
    week52_low_krw: toKrw(stats?.week52Low, scale),
  };
}

async function fetchYahooCandlesRaw(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance: no data for ${symbol}`);

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ t: ts[i], o, h, l, c, v: q.volume?.[i] ?? 0 });
  }
  return out;
}

function aggregateCandles(candles, n) {
  const out = [];
  for (let i = 0; i < candles.length; i += n) {
    const chunk = candles.slice(i, i + n);
    out.push({
      t: chunk[0].t,
      o: chunk[0].o,
      h: Math.max(...chunk.map(c => c.h)),
      l: Math.min(...chunk.map(c => c.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((sum, c) => sum + (c.v || 0), 0),
    });
  }
  return out;
}

/** interval: '1m'|'3m'|'5m'|'15m'|'30m'|'60m'|'1d'. OHLC는 전부 KRW로 환산됩니다. */
export async function getCandles(symbol, assetType, interval = "5m") {
  const cfg = CANDLE_INTERVALS[interval] || CANDLE_INTERVALS["5m"];
  const yahooSymbol = yahooTickerFor(symbol, assetType);
  const fx = await getUsdKrwRate();

  const candles = await cached(`candles:${assetType}:${symbol}:${interval}`, CANDLE_CACHE_TTL_MS, async () => {
    const raw = await fetchYahooCandlesRaw(yahooSymbol, cfg.yahooInterval, cfg.range);
    if (!raw.length) return [];
    const isKrw = assetType === "kr_stock";
    const scale = isKrw ? 1 : fx;
    const converted = raw.map(c => ({ t: c.t, o: c.o * scale, h: c.h * scale, l: c.l * scale, c: c.c * scale, v: c.v }));
    return cfg.aggregate > 1 ? aggregateCandles(converted, cfg.aggregate) : converted;
  });
  return candles ?? [];
}
