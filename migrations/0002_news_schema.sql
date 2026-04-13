-- Cyber news aggregator schema.
-- Re-runs are safe: every table is guarded by IF NOT EXISTS and seeds
-- use WHERE NOT EXISTS so the migration is idempotent.

CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fetched_at INTEGER,
  last_status TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  summary TEXT,
  content TEXT,
  published_at INTEGER,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(feed_id, guid)
);

CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles(feed_id);

-- One synthesis per (period, period_start). period_start is the unix
-- timestamp of 00:00 UTC of the day/week/month being synthesised.
CREATE TABLE IF NOT EXISTS syntheses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL CHECK(period IN ('day','week','fortnight','month')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  content TEXT NOT NULL,
  article_ids TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  provider TEXT,
  article_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(period, period_start)
);

CREATE INDEX IF NOT EXISTS idx_syntheses_period ON syntheses(period, period_start DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Default settings: Workers AI is the only provider that works without
-- an external API key, so it's the safe default.
INSERT INTO settings (key, value)
  SELECT 'llm_provider', 'workers-ai'
  WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='llm_provider');
INSERT INTO settings (key, value)
  SELECT 'llm_model', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
  WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='llm_model');
INSERT INTO settings (key, value)
  SELECT 'language', 'fr'
  WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='language');

-- Seed default feeds (international generalist cyber news). These are
-- only inserted on first run; users can edit/delete them afterwards.
INSERT INTO feeds (url, name)
  SELECT 'https://feeds.feedburner.com/TheHackersNews', 'The Hacker News'
  WHERE NOT EXISTS (SELECT 1 FROM feeds WHERE url='https://feeds.feedburner.com/TheHackersNews');
INSERT INTO feeds (url, name)
  SELECT 'https://www.bleepingcomputer.com/feed/', 'BleepingComputer'
  WHERE NOT EXISTS (SELECT 1 FROM feeds WHERE url='https://www.bleepingcomputer.com/feed/');
INSERT INTO feeds (url, name)
  SELECT 'https://krebsonsecurity.com/feed/', 'Krebs on Security'
  WHERE NOT EXISTS (SELECT 1 FROM feeds WHERE url='https://krebsonsecurity.com/feed/');
INSERT INTO feeds (url, name)
  SELECT 'https://www.darkreading.com/rss.xml', 'Dark Reading'
  WHERE NOT EXISTS (SELECT 1 FROM feeds WHERE url='https://www.darkreading.com/rss.xml');
INSERT INTO feeds (url, name)
  SELECT 'https://www.theregister.com/security/headlines.atom', 'The Register – Security'
  WHERE NOT EXISTS (SELECT 1 FROM feeds WHERE url='https://www.theregister.com/security/headlines.atom');
INSERT INTO feeds (url, name)
  SELECT 'https://www.securityweek.com/feed/', 'SecurityWeek'
  WHERE NOT EXISTS (SELECT 1 FROM feeds WHERE url='https://www.securityweek.com/feed/');
