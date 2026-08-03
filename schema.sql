-- papertrade D1 스키마 (Python 버전의 auth.py + portfolio.py 스키마와 동일)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  cash_krw REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS holdings (
  user_id INTEGER NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  avg_cost_krw REAL NOT NULL,
  PRIMARY KEY (user_id, symbol, asset_type)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  price_krw REAL NOT NULL,
  total_krw REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  limit_price_krw REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  filled_at TEXT,
  filled_price_krw REAL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
