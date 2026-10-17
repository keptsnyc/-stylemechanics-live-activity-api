CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, public_id TEXT NOT NULL, visitor_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, departed INTEGER NOT NULL DEFAULT 0,
  country TEXT, region TEXT, city TEXT, lat REAL, lng REAL,
  current_view TEXT NOT NULL DEFAULT 'Store', state TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS sessions_visitor ON sessions(visitor_key, created_at);
CREATE INDEX IF NOT EXISTS sessions_seen ON sessions(last_seen);
CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created_at);
CREATE TABLE IF NOT EXISTS locations (
  location_key TEXT PRIMARY KEY, country TEXT, region TEXT, city TEXT,
  lat REAL, lng REAL, lifetime INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS purchases (
  dedup_key TEXT PRIMARY KEY, public_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  country TEXT, region TEXT, city TEXT, lat REAL, lng REAL
);
CREATE INDEX IF NOT EXISTS purchases_created ON purchases(created_at);
