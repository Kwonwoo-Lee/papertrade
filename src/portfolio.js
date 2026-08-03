/**
 * portfolio.js - D1 기반 모의투자 계좌 (사용자별) - Python portfolio.py와 동일 로직
 * 반환 객체는 기존 파이썬 API와 동일한 snake_case 키를 씁니다
 * (프론트엔드 app.js를 그대로 재사용하기 위함).
 */
import { getQuote } from "./marketData.js";
import { lookupName } from "./symbols.js";

export const INITIAL_CASH_KRW = 10_000_000.0;

export class InsufficientFundsError extends Error {}
export class InsufficientHoldingsError extends Error {}
export class QuoteUnavailableError extends Error {}

export async function ensureAccount(db, userId) {
  await db.prepare(
    "INSERT OR IGNORE INTO account (user_id, cash_krw) VALUES (?, ?)"
  ).bind(userId, INITIAL_CASH_KRW).run();
}

export async function reset(db, userId) {
  await db.batch([
    db.prepare("DELETE FROM holdings WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM transactions WHERE user_id = ?").bind(userId),
    db.prepare("UPDATE account SET cash_krw = ? WHERE user_id = ?").bind(INITIAL_CASH_KRW, userId),
  ]);
}

async function getCash(db, userId) {
  const row = await db.prepare("SELECT cash_krw as cashKrw FROM account WHERE user_id = ?").bind(userId).first();
  return row ? row.cashKrw : INITIAL_CASH_KRW;
}

export async function buy(db, userId, symbol, assetType, quantity) {
  if (!quantity || quantity <= 0) throw new Error("수량은 0보다 커야 합니다.");
  const quote = await getQuote(symbol, assetType);
  if (!quote) throw new QuoteUnavailableError(`${symbol} 시세를 가져올 수 없습니다.`);
  const price = quote.price_krw;
  const total = price * quantity;

  const cash = await getCash(db, userId);
  if (total > cash) {
    throw new InsufficientFundsError(
      `현금이 부족합니다 (필요 ${Math.round(total).toLocaleString()}원, 보유 ${Math.round(cash).toLocaleString()}원)`);
  }

  const existing = await db.prepare(
    "SELECT quantity, avg_cost_krw as avgCostKrw FROM holdings WHERE user_id=? AND symbol=? AND asset_type=?"
  ).bind(userId, symbol, assetType).first();

  const now = new Date().toISOString();
  const stmts = [];
  if (existing) {
    const newQty = existing.quantity + quantity;
    const newAvg = (existing.quantity * existing.avgCostKrw + total) / newQty;
    stmts.push(db.prepare(
      "UPDATE holdings SET quantity=?, avg_cost_krw=? WHERE user_id=? AND symbol=? AND asset_type=?"
    ).bind(newQty, newAvg, userId, symbol, assetType));
  } else {
    stmts.push(db.prepare(
      "INSERT INTO holdings (user_id, symbol, asset_type, quantity, avg_cost_krw) VALUES (?,?,?,?,?)"
    ).bind(userId, symbol, assetType, quantity, price));
  }
  stmts.push(db.prepare("UPDATE account SET cash_krw = cash_krw - ? WHERE user_id = ?").bind(total, userId));
  stmts.push(db.prepare(
    "INSERT INTO transactions (user_id, symbol, asset_type, side, quantity, price_krw, total_krw, created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(userId, symbol, assetType, "buy", quantity, price, total, now));

  await db.batch(stmts);
  return { symbol, asset_type: assetType, side: "buy", quantity, price_krw: price, total_krw: total };
}

export async function sell(db, userId, symbol, assetType, quantity) {
  if (!quantity || quantity <= 0) throw new Error("수량은 0보다 커야 합니다.");
  const quote = await getQuote(symbol, assetType);
  if (!quote) throw new QuoteUnavailableError(`${symbol} 시세를 가져올 수 없습니다.`);
  const price = quote.price_krw;
  const total = price * quantity;

  const existing = await db.prepare(
    "SELECT quantity FROM holdings WHERE user_id=? AND symbol=? AND asset_type=?"
  ).bind(userId, symbol, assetType).first();
  const held = existing ? existing.quantity : 0;
  if (quantity > held) {
    throw new InsufficientHoldingsError(`보유 수량이 부족합니다 (매도하려는 ${quantity}, 보유 ${held})`);
  }

  const now = new Date().toISOString();
  const remaining = held - quantity;
  const stmts = [];
  if (remaining <= 1e-9) {
    stmts.push(db.prepare("DELETE FROM holdings WHERE user_id=? AND symbol=? AND asset_type=?")
      .bind(userId, symbol, assetType));
  } else {
    stmts.push(db.prepare("UPDATE holdings SET quantity=? WHERE user_id=? AND symbol=? AND asset_type=?")
      .bind(remaining, userId, symbol, assetType));
  }
  stmts.push(db.prepare("UPDATE account SET cash_krw = cash_krw + ? WHERE user_id = ?").bind(total, userId));
  stmts.push(db.prepare(
    "INSERT INTO transactions (user_id, symbol, asset_type, side, quantity, price_krw, total_krw, created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(userId, symbol, assetType, "sell", quantity, price, total, now));

  await db.batch(stmts);
  return { symbol, asset_type: assetType, side: "sell", quantity, price_krw: price, total_krw: total };
}

export async function getState(db, userId) {
  const cash = await getCash(db, userId);
  const { results: rows } = await db.prepare(
    "SELECT symbol, asset_type as assetType, quantity, avg_cost_krw as avgCostKrw FROM holdings WHERE user_id = ?"
  ).bind(userId).all();

  const quotes = await Promise.all(rows.map(r => getQuote(r.symbol, r.assetType)));

  let holdingsValue = 0;
  const holdings = rows.map((row, i) => {
    const quote = quotes[i];
    const currentPrice = quote ? quote.price_krw : row.avgCostKrw;
    const marketValue = currentPrice * row.quantity;
    const costBasis = row.avgCostKrw * row.quantity;
    const pl = marketValue - costBasis;
    const plPct = costBasis ? (pl / costBasis) * 100 : 0;
    holdingsValue += marketValue;
    return {
      symbol: row.symbol,
      asset_type: row.assetType,
      name: lookupName(row.symbol, row.assetType),
      quantity: row.quantity,
      avg_cost_krw: row.avgCostKrw,
      current_price_krw: currentPrice,
      day_change_pct: quote ? quote.change_pct : 0,
      market_value_krw: marketValue,
      unrealized_pl_krw: pl,
      unrealized_pl_pct: plPct,
    };
  });
  holdings.sort((a, b) => b.market_value_krw - a.market_value_krw);

  const totalValue = cash + holdingsValue;
  const totalPl = totalValue - INITIAL_CASH_KRW;

  return {
    cash_krw: cash,
    holdings_value_krw: holdingsValue,
    total_value_krw: totalValue,
    initial_cash_krw: INITIAL_CASH_KRW,
    total_pl_krw: totalPl,
    total_pl_pct: (totalPl / INITIAL_CASH_KRW) * 100,
    holdings,
  };
}

export async function getTransactions(db, userId, limit = 100) {
  const { results } = await db.prepare(
    "SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?"
  ).bind(userId, limit).all();
  return results; // 컬럼명이 이미 snake_case (id, symbol, asset_type, side, quantity, price_krw, total_krw, created_at)
}

export async function getLeaderboard(db) {
  const { results: users } = await db.prepare("SELECT id, username FROM users").all();
  const { results: cashRows } = await db.prepare("SELECT user_id as userId, cash_krw as cashKrw FROM account").all();
  const { results: holdingRows } = await db.prepare(
    "SELECT user_id as userId, symbol, asset_type as assetType, quantity, avg_cost_krw as avgCostKrw FROM holdings"
  ).all();

  const cashByUser = new Map(cashRows.map(r => [r.userId, r.cashKrw]));
  const holdingsByUser = new Map();
  for (const r of holdingRows) {
    if (!holdingsByUser.has(r.userId)) holdingsByUser.set(r.userId, []);
    holdingsByUser.get(r.userId).push(r);
  }

  const distinctKeys = [...new Set(holdingRows.map(r => `${r.symbol}::${r.assetType}`))];
  const quoteEntries = await Promise.all(distinctKeys.map(async key => {
    const [symbol, assetType] = key.split("::");
    return [key, await getQuote(symbol, assetType)];
  }));
  const quoteMap = new Map(quoteEntries);

  const results = users.map(u => {
    const cash = cashByUser.has(u.id) ? cashByUser.get(u.id) : INITIAL_CASH_KRW;
    const holdings = holdingsByUser.get(u.id) || [];
    let holdingsValue = 0;
    for (const h of holdings) {
      const quote = quoteMap.get(`${h.symbol}::${h.assetType}`);
      const price = quote ? quote.price_krw : h.avgCostKrw;
      holdingsValue += price * h.quantity;
    }
    const totalValue = cash + holdingsValue;
    const pl = totalValue - INITIAL_CASH_KRW;
    return {
      user_id: u.id,
      username: u.username,
      total_value_krw: totalValue,
      total_pl_krw: pl,
      total_pl_pct: (pl / INITIAL_CASH_KRW) * 100,
      holdings_count: holdings.length,
    };
  });

  results.sort((a, b) => b.total_pl_pct - a.total_pl_pct);
  results.forEach((r, i) => { r.rank = i + 1; });
  return results;
}
