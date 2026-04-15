// Thin D1 helpers. Keep queries in one place to make the API handlers
// easier to read.

export async function getSettings(DB) {
  const { results } = await DB.prepare(
    "SELECT key, value FROM settings",
  ).all();
  const out = {};
  for (const r of results) out[r.key] = r.value;
  return out;
}

export async function setSetting(DB, key, value) {
  await DB.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?1, ?2, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()`,
  )
    .bind(key, value)
    .run();
}

export async function listFeeds(DB) {
  const { results } = await DB.prepare(
    `SELECT id, url, name, enabled, last_fetched_at, last_status, created_at
       FROM feeds
       ORDER BY name COLLATE NOCASE`,
  ).all();
  return results;
}

export async function articlesInRange(DB, startEpoch, endEpoch, { limit = 400 } = {}) {
  const { results } = await DB.prepare(
    `SELECT a.id, a.feed_id, a.url, a.title, a.author, a.summary,
            a.published_at, f.name AS feed_name
       FROM articles a
       JOIN feeds f ON f.id = a.feed_id
      WHERE COALESCE(a.published_at, a.fetched_at) BETWEEN ?1 AND ?2
      ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
      LIMIT ?3`,
  )
    .bind(startEpoch, endEpoch, limit)
    .all();
  return results;
}

// Variant used by the vector consolidation pipeline: also pulls the
// full-text columns so the caller can decide whether to re-fetch.
export async function articlesInRangeWithFulltext(DB, startEpoch, endEpoch, { limit = 400 } = {}) {
  const { results } = await DB.prepare(
    `SELECT a.id, a.feed_id, a.url, a.title, a.author, a.summary,
            a.content, a.fulltext, a.fulltext_fetched_at, a.fulltext_status,
            a.published_at, f.name AS feed_name
       FROM articles a
       JOIN feeds f ON f.id = a.feed_id
      WHERE COALESCE(a.published_at, a.fetched_at) BETWEEN ?1 AND ?2
      ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
      LIMIT ?3`,
  )
    .bind(startEpoch, endEpoch, limit)
    .all();
  return results;
}

export async function updateArticleFulltext(DB, articleId, text, status) {
  await DB.prepare(
    `UPDATE articles
        SET fulltext = ?1,
            fulltext_fetched_at = unixepoch(),
            fulltext_status = ?2
      WHERE id = ?3`,
  )
    .bind(text, status, articleId)
    .run();
}

export async function getEmbeddedArticleIds(DB, articleIds, model) {
  if (!articleIds.length) return new Set();
  // D1 prepared statements cap at ~100 bind params; chunk if needed.
  const chunks = [];
  for (let i = 0; i < articleIds.length; i += 80) {
    chunks.push(articleIds.slice(i, i + 80));
  }
  const embedded = new Set();
  for (const chunk of chunks) {
    const placeholders = chunk.map((_, i) => `?${i + 2}`).join(",");
    const { results } = await DB.prepare(
      `SELECT article_id FROM article_embeddings
        WHERE model = ?1 AND article_id IN (${placeholders})`,
    )
      .bind(model, ...chunk)
      .all();
    for (const r of results) embedded.add(r.article_id);
  }
  return embedded;
}

export async function markEmbedded(DB, articleId, model, dim, indexName) {
  await DB.prepare(
    `INSERT INTO article_embeddings (article_id, model, dim, index_name, embedded_at)
     VALUES (?1, ?2, ?3, ?4, unixepoch())
     ON CONFLICT(article_id, model) DO UPDATE SET
        dim = excluded.dim,
        index_name = excluded.index_name,
        embedded_at = unixepoch()`,
  )
    .bind(articleId, model, dim, indexName)
    .run();
}

export async function getSynthesis(DB, period, periodStart, mode = "llm") {
  const row = await DB.prepare(
    `SELECT id, period, period_start, period_end, mode, content,
            article_ids, model, provider, article_count, created_at
       FROM syntheses
      WHERE period = ?1 AND period_start = ?2 AND mode = ?3`,
  )
    .bind(period, periodStart, mode)
    .first();
  return row || null;
}

export async function upsertSynthesis(DB, row) {
  const mode = row.mode || "llm";
  await DB.prepare(
    `INSERT INTO syntheses (period, period_start, period_end, mode, content,
                            article_ids, model, provider, article_count, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, unixepoch())
     ON CONFLICT(period, period_start, mode) DO UPDATE SET
        period_end = excluded.period_end,
        content = excluded.content,
        article_ids = excluded.article_ids,
        model = excluded.model,
        provider = excluded.provider,
        article_count = excluded.article_count,
        created_at = unixepoch()`,
  )
    .bind(
      row.period,
      row.period_start,
      row.period_end,
      mode,
      row.content,
      row.article_ids,
      row.model,
      row.provider,
      row.article_count,
    )
    .run();
}
