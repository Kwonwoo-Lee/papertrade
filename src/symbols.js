/**
 * symbols.js - 검색/디스커버리용 종목 카탈로그 (Python symbols.py와 동일)
 */

export const KR_STOCKS = [
  { symbol: "005930.KS", name: "삼성전자" },
  { symbol: "000660.KS", name: "SK하이닉스" },
  { symbol: "373220.KS", name: "LG에너지솔루션" },
  { symbol: "207940.KS", name: "삼성바이오로직스" },
  { symbol: "005380.KS", name: "현대차" },
  { symbol: "000270.KS", name: "기아" },
  { symbol: "035420.KS", name: "NAVER" },
  { symbol: "035720.KS", name: "카카오" },
  { symbol: "068270.KS", name: "셀트리온" },
  { symbol: "005490.KS", name: "POSCO홀딩스" },
  { symbol: "051910.KS", name: "LG화학" },
  { symbol: "006400.KS", name: "삼성SDI" },
  { symbol: "028260.KS", name: "삼성물산" },
  { symbol: "105560.KS", name: "KB금융" },
  { symbol: "247540.KQ", name: "에코프로비엠" },
];

export const US_STOCKS = [
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "GOOGL", name: "Alphabet (Google)" },
  { symbol: "AMZN", name: "Amazon" },
  { symbol: "NVDA", name: "NVIDIA" },
  { symbol: "TSLA", name: "Tesla" },
  { symbol: "META", name: "Meta" },
  { symbol: "NFLX", name: "Netflix" },
  { symbol: "AMD", name: "AMD" },
  { symbol: "AVGO", name: "Broadcom" },
  { symbol: "QQQ", name: "Invesco QQQ (나스닥100 ETF)" },
  { symbol: "SPY", name: "SPDR S&P 500 ETF" },
];

// yahoo: 실시간가/등락률/당일통계/분봉 캔들차트 조회용 야후 파이낸스 티커
export const CRYPTO = [
  { symbol: "bitcoin", name: "Bitcoin (BTC)", yahoo: "BTC-USD" },
  { symbol: "ethereum", name: "Ethereum (ETH)", yahoo: "ETH-USD" },
  { symbol: "solana", name: "Solana (SOL)", yahoo: "SOL-USD" },
  { symbol: "ripple", name: "XRP", yahoo: "XRP-USD" },
  { symbol: "dogecoin", name: "Dogecoin (DOGE)", yahoo: "DOGE-USD" },
  { symbol: "cardano", name: "Cardano (ADA)", yahoo: "ADA-USD" },
  { symbol: "avalanche-2", name: "Avalanche (AVAX)", yahoo: "AVAX-USD" },
  { symbol: "chainlink", name: "Chainlink (LINK)", yahoo: "LINK-USD" },
];

export const CATALOG = [
  ...KR_STOCKS.map(s => ({ ...s, assetType: "kr_stock" })),
  ...US_STOCKS.map(s => ({ ...s, assetType: "us_stock" })),
  ...CRYPTO.map(s => ({ ...s, assetType: "crypto" })),
];

export function search(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  return CATALOG
    .filter(item => item.symbol.toLowerCase().includes(q) || item.name.toLowerCase().includes(q))
    .slice(0, 20);
}

export function lookupName(symbol, assetType) {
  const item = CATALOG.find(i => i.symbol === symbol && i.assetType === assetType);
  return item ? item.name : symbol;
}

export function catalogFor(assetType) {
  return { kr_stock: KR_STOCKS, us_stock: US_STOCKS, crypto: CRYPTO }[assetType] || [];
}

export function yahooTickerFor(symbol, assetType) {
  if (assetType !== "crypto") return symbol;
  const item = CRYPTO.find(c => c.symbol === symbol);
  return item ? item.yahoo : symbol;
}
