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

export async function getSynthesis(DB, period, periodStart) {
  const row = await DB.prepare(
    `SELECT id, period, period_start, period_end, content,
            article_ids, model, provider, article_count, created_at
       FROM syntheses
      WHERE period = ?1 AND period_start = ?2`,
  )
    .bind(period, periodStart)
    .first();
  return row || null;
}

export async function upsertSynthesis(DB, row) {
  await DB.prepare(
    `INSERT INTO syntheses (period, period_start, period_end, content,
                            article_ids, model, provider, article_count, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch())
     ON CONFLICT(period, period_start) DO UPDATE SET
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
      row.content,
      row.article_ids,
      row.model,
      row.provider,
      row.article_count,
    )
    .run();
}
