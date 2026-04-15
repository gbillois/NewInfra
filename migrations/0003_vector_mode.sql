-- Vector consolidation mode: full-text fetching, embedding cache, and
-- per-mode synthesis storage.
-- Re-runs are safe: additive columns are guarded by existence checks
-- and new tables use IF NOT EXISTS. Existing rows in `syntheses` keep a
-- NULL `mode` which we interpret as 'llm' (the legacy mode).

-- 1. Full article text fetched from the source URL, used as the
--    primary input for embedding. The RSS `content`/`summary` fields
--    are kept untouched so the legacy LLM mode is unaffected.
--
--    D1 (SQLite) has no IF NOT EXISTS on ADD COLUMN; the deploy workflow
--    runs migrations only once per file, so these ALTERs are safe on a
--    fresh DB. For re-application safety we catch errors at runtime
--    rather than here — see the deploy workflow.
ALTER TABLE articles ADD COLUMN fulltext TEXT;
ALTER TABLE articles ADD COLUMN fulltext_fetched_at INTEGER;
ALTER TABLE articles ADD COLUMN fulltext_status TEXT;

-- 2. Embedding cache. One row per (article, model) we've embedded.
--    Vectors themselves live in Cloudflare Vectorize (indexed by
--    article_id as a string); this table just records what's been sent
--    so we can skip re-embedding on subsequent refreshes.
CREATE TABLE IF NOT EXISTS article_embeddings (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  index_name TEXT NOT NULL,
  embedded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (article_id, model)
);

CREATE INDEX IF NOT EXISTS idx_article_embeddings_model
  ON article_embeddings(model, embedded_at DESC);

-- 3. `syntheses.mode` distinguishes consolidation strategies. Old rows
--    have NULL; the application treats NULL as 'llm'. The unique
--    constraint expands to (period, period_start, mode) so the same
--    period can hold one synthesis per mode simultaneously.
--
--    SQLite can't DROP a UNIQUE constraint in place, so we migrate by
--    rebuilding the table. The INSERT ... SELECT preserves existing
--    syntheses and backfills mode='llm' for them.
CREATE TABLE IF NOT EXISTS syntheses_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL CHECK(period IN ('day','week','fortnight','month')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'llm'
       CHECK(mode IN ('llm','vector-narrative','vector-raw')),
  content TEXT NOT NULL,
  article_ids TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  provider TEXT,
  article_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(period, period_start, mode)
);

INSERT INTO syntheses_new
  (id, period, period_start, period_end, mode, content, article_ids,
   model, provider, article_count, created_at)
SELECT id, period, period_start, period_end, 'llm', content, article_ids,
       model, provider, article_count, created_at
  FROM syntheses;

DROP TABLE syntheses;
ALTER TABLE syntheses_new RENAME TO syntheses;

CREATE INDEX IF NOT EXISTS idx_syntheses_period
  ON syntheses(period, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_syntheses_mode
  ON syntheses(mode, period, period_start DESC);

-- 4. Default settings for the vector mode. Users can override these
--    later from /settings.html (UI wiring is optional v1).
INSERT INTO settings (key, value)
  SELECT 'vector_similarity_threshold', '0.75'
  WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='vector_similarity_threshold');
INSERT INTO settings (key, value)
  SELECT 'vector_embed_model_workers_ai', '@cf/baai/bge-m3'
  WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='vector_embed_model_workers_ai');
INSERT INTO settings (key, value)
  SELECT 'vector_embed_model_openai', 'text-embedding-3-small'
  WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key='vector_embed_model_openai');
