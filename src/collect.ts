import { parseFeed } from './rss';
import { embedTexts, toBlob, fromBlob, dot } from './embed';
import type { Env, FeedRow } from './types';

// Pipeline d'ingestion : fetch des flux → insertion → embeddings →
// dédoublonnage des quasi-doublons inter-sources.

const FETCH_TIMEOUT_MS = 15000;
const MAX_AGE_DAYS = 400; // on ignore les articles plus vieux (flux mal datés)
const EMBED_BATCH = 60; // articles vectorisés max par exécution
const DUP_WINDOW_DAYS = 4; // fenêtre de comparaison pour les doublons
const DUP_THRESHOLD = 0.92;

export interface CollectStats {
  feeds: number;
  fetched: number;
  inserted: number;
  embedded: number;
  duplicates: number;
  errors: string[];
}

async function sha256hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function collectAll(env: Env): Promise<CollectStats> {
  const stats: CollectStats = { feeds: 0, fetched: 0, inserted: 0, embedded: 0, duplicates: 0, errors: [] };
  const feeds = (await env.DB.prepare('SELECT * FROM feeds WHERE enabled = 1').all<FeedRow>()).results;
  stats.feeds = feeds.length;
  const now = Math.floor(Date.now() / 1000);
  const minDate = now - MAX_AGE_DAYS * 86400;

  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f)));
  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    const r = results[i];
    if (r.status === 'rejected') {
      stats.errors.push(`${feed.name}: ${r.reason}`);
      await env.DB.prepare('UPDATE feeds SET last_fetched_at = ?, last_status = ? WHERE id = ?')
        .bind(now, String(r.reason).slice(0, 200), feed.id).run();
      continue;
    }
    const items = r.value.filter((it) => it.publishedAt >= minDate);
    stats.fetched += items.length;
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO articles (feed_id, guid, url, url_hash, title, summary, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const batch: D1PreparedStatement[] = [];
    for (const it of items) {
      const hash = await sha256hex(it.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase());
      batch.push(stmt.bind(feed.id, it.guid, it.url, hash, it.title, it.summary, it.publishedAt));
    }
    if (batch.length) {
      const res = await env.DB.batch(batch);
      stats.inserted += res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    }
    await env.DB.prepare('UPDATE feeds SET last_fetched_at = ?, last_status = ? WHERE id = ?')
      .bind(now, 'ok', feed.id).run();
  }

  stats.embedded = await embedNewArticles(env);
  stats.duplicates = await dedupeRecent(env);
  return stats;
}

async function fetchFeed(feed: FeedRow) {
  const res = await fetch(feed.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'NewsRadar/1.0 (+cloudflare-worker)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text());
}

/** Vectorise les articles sans embedding (les plus récents d'abord). */
async function embedNewArticles(env: Env): Promise<number> {
  const rows = (await env.DB.prepare(
    'SELECT id, title, summary FROM articles WHERE embedding IS NULL ORDER BY id DESC LIMIT ?'
  ).bind(EMBED_BATCH).all<{ id: number; title: string; summary: string | null }>()).results;
  if (!rows.length) return 0;
  const texts = rows.map((r) => `${r.title}. ${(r.summary ?? '').slice(0, 800)}`);
  const vecs = await embedTexts(env, texts);
  const stmt = env.DB.prepare('UPDATE articles SET embedding = ? WHERE id = ?');
  await env.DB.batch(rows.map((r, i) => stmt.bind(toBlob(vecs[i]), r.id)));
  return rows.length;
}

/**
 * Marque les quasi-doublons : un article très similaire (cosinus ≥ seuil) à
 * un article antérieur dans une fenêtre de ±4 jours pointe vers ce canonique.
 * Seuls les articles non encore comparés (duplicate_of IS NULL et plus récents
 * que le dernier passage) sont traités, pour rester léger en CPU.
 */
async function dedupeRecent(env: Env): Promise<number> {
  const since = Math.floor(Date.now() / 1000) - DUP_WINDOW_DAYS * 2 * 86400;
  const rows = (await env.DB.prepare(
    `SELECT id, published_at, duplicate_of, embedding FROM articles
     WHERE published_at >= ? AND embedding IS NOT NULL ORDER BY published_at ASC, id ASC`
  ).bind(since).all<any>()).results;

  const canon: { id: number; published_at: number; vec: Float32Array }[] = [];
  const updates: D1PreparedStatement[] = [];
  const stmt = env.DB.prepare('UPDATE articles SET duplicate_of = ? WHERE id = ?');
  let marked = 0;

  for (const row of rows) {
    const vec = fromBlob(row.embedding);
    if (!vec) continue;
    if (row.duplicate_of !== null) continue; // déjà classé doublon
    let dupOf: number | null = null;
    for (let i = canon.length - 1; i >= 0; i--) {
      const c = canon[i];
      if (row.published_at - c.published_at > DUP_WINDOW_DAYS * 86400) break;
      if (c.id !== row.id && dot(vec, c.vec) >= DUP_THRESHOLD) { dupOf = c.id; break; }
    }
    if (dupOf !== null) {
      updates.push(stmt.bind(dupOf, row.id));
      marked++;
    } else {
      canon.push({ id: row.id, published_at: row.published_at, vec });
    }
  }
  if (updates.length) await env.DB.batch(updates);
  return marked;
}
