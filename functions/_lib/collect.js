// Fetch all enabled feeds and upsert their items into the articles
// table. Designed to be called by the cron endpoint and by the UI
// "refresh" button. Fails soft per-feed: a single broken feed must not
// stop the whole collection run.

import { fetchAndParseFeed } from "./rss.js";

export async function collectAllFeeds(env) {
  const DB = env.DB;
  const { results: feeds } = await DB.prepare(
    "SELECT id, url, name FROM feeds WHERE enabled = 1",
  ).all();

  const report = [];
  for (const feed of feeds) {
    try {
      const items = await fetchAndParseFeed(feed.url);
      let inserted = 0;
      for (const it of items) {
        if (!it.guid || !it.url || !it.title) continue;
        const r = await DB.prepare(
          `INSERT OR IGNORE INTO articles
             (feed_id, guid, url, title, author, summary, content, published_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
          .bind(
            feed.id,
            it.guid,
            it.url,
            it.title,
            it.author,
            it.summary,
            it.content,
            it.published_at,
          )
          .run();
        // D1 reports `meta.changes` for rowcount; >0 means inserted.
        if (r.meta && r.meta.changes > 0) inserted++;
      }
      await DB.prepare(
        "UPDATE feeds SET last_fetched_at = unixepoch(), last_status = ?1 WHERE id = ?2",
      )
        .bind(`ok (${items.length} items, ${inserted} new)`, feed.id)
        .run();
      report.push({ id: feed.id, name: feed.name, ok: true, items: items.length, inserted });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err).slice(0, 200);
      await DB.prepare(
        "UPDATE feeds SET last_fetched_at = unixepoch(), last_status = ?1 WHERE id = ?2",
      )
        .bind(`error: ${msg}`, feed.id)
        .run();
      report.push({ id: feed.id, name: feed.name, ok: false, error: msg });
    }
  }
  return report;
}
