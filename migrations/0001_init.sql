-- NewsRadar — schéma initial.

CREATE TABLE feeds (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fetched_at INTEGER,
  last_status TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE articles (
  id INTEGER PRIMARY KEY,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT,
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  -- Embedding bge-m3 (1024 x float32) sérialisé en blob ; NULL tant que
  -- l'article n'a pas été vectorisé.
  embedding BLOB,
  -- Pointe vers l'article "canonique" si quasi-doublon détecté.
  duplicate_of INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  UNIQUE(feed_id, guid)
);
CREATE INDEX idx_articles_published ON articles(published_at);
CREATE INDEX idx_articles_dup ON articles(duplicate_of);

-- Un "trend set" = le résultat d'un calcul de tendances pour une fenêtre
-- temporelle donnée (7d, 30d, month:YYYY-MM, 180d, 365d, custom).
CREATE TABLE trend_sets (
  id INTEGER PRIMARY KEY,
  window_key TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  generated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  article_count INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  model TEXT,
  UNIQUE(window_key, period_start, period_end)
);

CREATE TABLE trends (
  id INTEGER PRIMARY KEY,
  set_id INTEGER NOT NULL REFERENCES trend_sets(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  theme TEXT,
  score REAL NOT NULL DEFAULT 0,
  article_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_trends_set ON trends(set_id);

CREATE TABLE trend_articles (
  trend_id INTEGER NOT NULL REFERENCES trends(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (trend_id, article_id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Flux préconfigurés (cyber + IA, FR + EN) — modifiables dans l'UI.
INSERT INTO feeds (url, name) VALUES
  ('https://feeds.feedburner.com/TheHackersNews', 'The Hacker News'),
  ('https://www.bleepingcomputer.com/feed/', 'BleepingComputer'),
  ('https://krebsonsecurity.com/feed/', 'Krebs on Security'),
  ('https://www.darkreading.com/rss.xml', 'Dark Reading'),
  ('https://www.cert.ssi.gouv.fr/feed/', 'CERT-FR'),
  ('https://techcrunch.com/category/artificial-intelligence/feed/', 'TechCrunch AI'),
  ('https://venturebeat.com/category/ai/feed/', 'VentureBeat AI'),
  ('https://www.theverge.com/rss/index.xml', 'The Verge'),
  ('https://www.numerama.com/feed/', 'Numerama'),
  ('https://www.actuia.com/feed/', 'ActuIA');
