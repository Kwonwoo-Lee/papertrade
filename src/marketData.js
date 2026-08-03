/**
 * marketData.js - 국내주식/미국주식/코인 실시간(근접) 시세 통합 조회
 * ====================================================================
 * Cloudflare Workers는 Python(yfinance)을 못 돌리므로, yfinance가 내부적으로
 * 호출하는 것과 같은 Yahoo Finance 원시 차트 API를 fetch로 직접 호출합니다.
 * 코인은 Python 버전과 동일하게 CoinGecko 공개 API를 씁니다.
 * 전부 KRW로 환산해서 반환합니다. 모듈 스코프의 간단한 TTL 캐시로
 * 같은 워커 인스턴스 안에서 반복 조회를 줄입니다(정확한 분산 캐시는
 * 아니지만, Python 버전의 in-memory 캐시와 동일한 수준의 최적화입니다).
 */

const CACHE_TTL_MS = 15_000;
const CRYPTO_CACHE_TTL_MS = 30_000; // CoinGecko 무료 API는 요청 제한이 더 엄격함
const cache = new Map(); // key -> { at, value }

const BROWSER_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; papertrade/1.0)" };

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
    points: timestamps.map((t, i) => ({ t, close: result.indicators.quote[0].close[i] }))
      .filter(p => p.close !== null && p.close !== undefined),
  };
}

async function stockQuote(ticker) {
  return cached(`quote:${ticker}`, CACHE_TTL_MS, async () => {
    const raw = await fetchYahooChart(ticker, "5d");
    if (!raw) return null;
    return { priceNative: raw.price, currency: raw.currency, changePct: raw.changePct };
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

/** assetType: 'kr_stock' | 'us_stock' | 'crypto'. 반환 price는 항상 KRW로 환산됩니다. */
export async function getQuote(symbol, assetType) {
  const raw = assetType === "crypto" ? await cryptoQuote(symbol) : await stockQuote(symbol);
  if (!raw) return null;
  const fx = await getUsdKrwRate();
  const priceKrw = raw.currency === "USD" ? raw.priceNative * fx : raw.priceNative;
  // 기존 파이썬 API와 동일한 snake_case 키로 반환 - 프론트엔드(app.js)를 그대로 재사용하기 위함
  return {
    symbol,
    asset_type: assetType,
    price_krw: Math.round(priceKrw * 100) / 100,
    price_native: raw.priceNative,
    currency: raw.currency,
    change_pct: raw.changePct,
  };
}

export async function getHistory(symbol, assetType, days = 30) {
  const fx = await getUsdKrwRate();

  if (assetType === "crypto") {
    return cached(`hist:crypto:${symbol}:${days}`, 120_000, async () => {
      const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(symbol)}/market_chart?vs_currency=usd&days=${days}`;
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
      const data = await res.json();
      return (data.prices || []).map(([tsMs, price]) => ({ t: Math.floor(tsMs / 1000), close: price * fx }));
    }) ?? [];
  }

  return cached(`hist:${symbol}:${days}`, 120_000, async () => {
    const range = days <= 5 ? "5d" : days <= 30 ? "1mo" : days <= 90 ? "3mo" : "1y";
    const raw = await fetchYahooChart(symbol, range);
    if (!raw) return [];
    const isKrw = symbol.endsWith(".KS") || symbol.endsWith(".KQ");
    return raw.points.map(p => ({ t: p.t, close: isKrw ? p.close : p.close * fx }));
  }) ?? [];
}
