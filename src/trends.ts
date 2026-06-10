import { llmTrends, llmItemCapacity, type LlmTrend } from './llm';
import type { Env, TrendRow, TrendSetRow } from './types';

// Moteur de tendances.
//
// Fenêtres courtes (≤ 45 jours) : les articles canoniques (dédupliqués) de la
// période sont envoyés au LLM qui les regroupe en tendances nommées. Un
// article peut appartenir à plusieurs tendances.
//
// Fenêtres longues (6 mois, 12 mois, custom long) : agrégation hiérarchique —
// on s'assure que chaque mois de la période a son trend set mensuel, puis le
// LLM fusionne ces tendances mensuelles en macro-tendances de fond.

const SHORT_WINDOW_MAX_DAYS = 45;
const DAY = 86400;

export const STANDARD_WINDOWS = ['7d', '30d', '180d', '365d'] as const;

export interface ComputedSet {
  set: TrendSetRow;
  trends: TrendRow[];
}

export function windowBounds(key: string, now = Math.floor(Date.now() / 1000)): { start: number; end: number } {
  const m = key.match(/^(\d+)d$/);
  if (m) return { start: now - Number(m[1]) * DAY, end: now };
  const month = key.match(/^month:(\d{4})-(\d{2})$/);
  if (month) {
    const y = Number(month[1]);
    const mo = Number(month[2]);
    const start = Date.UTC(y, mo - 1, 1) / 1000;
    const end = Date.UTC(y, mo, 1) / 1000;
    return { start, end: Math.min(end, now) };
  }
  throw new Error(`Fenêtre inconnue: ${key}`);
}

function maxTrendsFor(days: number): number {
  if (days <= 10) return 8;
  if (days <= 45) return 10;
  return 12;
}

/** Renvoie le set stocké s'il existe (et est assez frais), sinon null. */
export async function getStoredSet(
  env: Env, windowKey: string, start: number, end: number, maxAgeSeconds: number | null
): Promise<ComputedSet | null> {
  // Pour les fenêtres glissantes, on tolère un set dont la borne de fin est
  // proche (recalculé chaque nuit par le cron).
  const set = (await env.DB.prepare(
    `SELECT * FROM trend_sets WHERE window_key = ? AND period_start BETWEEN ? AND ? AND period_end BETWEEN ? AND ?
     ORDER BY generated_at DESC LIMIT 1`
  ).bind(windowKey, start - DAY, start + DAY, end - DAY, end + DAY).first<TrendSetRow>());
  if (!set) return null;
  if (maxAgeSeconds !== null && Date.now() / 1000 - set.generated_at > maxAgeSeconds) return null;
  const trends = (await env.DB.prepare(
    'SELECT * FROM trends WHERE set_id = ? ORDER BY rank ASC'
  ).bind(set.id).all<TrendRow>()).results;
  return { set, trends };
}

export async function getOrComputeSet(
  env: Env, windowKey: string, start: number, end: number, force = false
): Promise<ComputedSet> {
  if (!force) {
    // Mois révolus : immuables. Fenêtres glissantes : valides 26 h.
    const closedMonth = windowKey.startsWith('month:') && end < Date.now() / 1000 - DAY;
    const stored = await getStoredSet(env, windowKey, start, end, closedMonth ? null : 26 * 3600);
    if (stored) return stored;
  }
  return await computeSet(env, windowKey, start, end);
}

export async function computeSet(env: Env, windowKey: string, start: number, end: number): Promise<ComputedSet> {
  const days = (end - start) / DAY;
  if (days <= SHORT_WINDOW_MAX_DAYS) return await computeShortSet(env, windowKey, start, end);
  return await computeMacroSet(env, windowKey, start, end);
}

// ---------------------------------------------------------------- court

interface StoryItem {
  id: number;
  title: string;
  published_at: number;
  source: string;
  dup_count: number;
}

async function computeShortSet(env: Env, windowKey: string, start: number, end: number): Promise<ComputedSet> {
  const capacity = llmItemCapacity(env);
  const items = (await env.DB.prepare(
    `SELECT a.id, a.title, a.published_at, f.name AS source,
            (SELECT COUNT(*) FROM articles d WHERE d.duplicate_of = a.id) AS dup_count
     FROM articles a JOIN feeds f ON f.id = a.feed_id
     WHERE a.duplicate_of IS NULL AND a.published_at >= ? AND a.published_at < ?
     ORDER BY dup_count DESC, a.published_at DESC LIMIT ?`
  ).bind(start, end, capacity).all<StoryItem>()).results;

  if (items.length === 0) {
    return await persistSet(env, windowKey, start, end, [], 0, 'none', 'none', new Map());
  }

  const days = Math.round((end - start) / DAY);
  const maxTrends = maxTrendsFor(days);
  const system =
    `Tu es un analyste de veille stratégique (cybersécurité, IA, tech). On te fournit la liste des actualités ` +
    `publiées sur une période de ${days} jours, au format "id | date | source(s) | titre". ` +
    `Identifie les ${maxTrends} tendances majeures de la période, de la plus importante à la moins importante. ` +
    `Une tendance regroupe les actualités qui relèvent d'un même phénomène, événement ou sujet de fond. ` +
    `Pour chaque tendance : un titre court et percutant en FRANÇAIS (style "Sortie d'Opus 4.8", "Vague de ransomware sur les hôpitaux"), ` +
    `un résumé factuel de 2 à 3 phrases en FRANÇAIS, un thème (cyber, ia, tech, business, autre), ` +
    `un score d'importance de 0 à 100 (ampleur, impact, volume et diversité des sources), ` +
    `et item_ids = la liste des ids d'actualités concernées. ` +
    `Une actualité PEUT appartenir à plusieurs tendances quand elle touche plusieurs sujets. ` +
    `N'invente rien, ne crée pas de tendance fourre-tout, ignore les actualités anecdotiques isolées.`;
  const lines = items.map((it) => {
    const d = new Date(it.published_at * 1000).toISOString().slice(0, 10);
    const src = it.dup_count > 0 ? `${it.source} +${it.dup_count} autres sources` : it.source;
    return `${it.id} | ${d} | ${src} | ${it.title}`;
  });
  const user = `Actualités de la période :\n${lines.join('\n')}`;

  const result = await llmTrends(env, system, user);
  const validIds = new Set(items.map((i) => i.id));
  const trends = sanitize(result.trends, validIds, maxTrends);

  // item_ids = articles canoniques → on rattache aussi leurs doublons.
  const articleMap = new Map<number, Map<number, number>>(); // trendIdx -> articleId -> weight
  for (let t = 0; t < trends.length; t++) {
    const map = new Map<number, number>();
    for (const id of trends[t].item_ids) map.set(id, 1);
    articleMap.set(t, map);
  }
  const allCanonIds = [...new Set(trends.flatMap((t) => t.item_ids))];
  if (allCanonIds.length) {
    const dups = await selectIn<{ id: number; duplicate_of: number }>(
      env, 'SELECT id, duplicate_of FROM articles WHERE duplicate_of IN', allCanonIds
    );
    for (let t = 0; t < trends.length; t++) {
      const map = articleMap.get(t)!;
      for (const d of dups) if (map.has(d.duplicate_of)) map.set(d.id, 0.8);
    }
  }

  return await persistSet(env, windowKey, start, end, trends, items.length, result.provider, result.model, articleMap);
}

// ---------------------------------------------------------------- macro

async function computeMacroSet(env: Env, windowKey: string, start: number, end: number): Promise<ComputedSet> {
  // 1. S'assurer que chaque mois de la période a son set mensuel.
  const months = monthsBetween(start, end);
  const monthlySets: ComputedSet[] = [];
  for (const mk of months) {
    const b = windowBounds(mk);
    if (b.end <= b.start) continue;
    try {
      monthlySets.push(await getOrComputeSet(env, mk, b.start, b.end));
    } catch (e) {
      console.error(`trend set ${mk} en échec:`, e);
    }
  }
  const monthlyTrends = monthlySets.flatMap((s) =>
    s.trends.map((t) => ({ ...t, month: s.set.window_key.slice(6) }))
  );
  if (monthlyTrends.length === 0) {
    return await persistSet(env, windowKey, start, end, [], 0, 'none', 'none', new Map());
  }

  // 2. Fusion LLM des tendances mensuelles en macro-tendances.
  const days = Math.round((end - start) / DAY);
  const maxTrends = maxTrendsFor(days);
  const system =
    `Tu es un analyste de veille stratégique (cybersécurité, IA, tech). On te fournit les tendances détectées ` +
    `mois par mois sur une période de ${days} jours, au format "id | mois | nb articles | titre — résumé". ` +
    `Dégage les ${maxTrends} grandes tendances de fond de la période, de la plus importante à la moins importante, ` +
    `en regroupant les tendances mensuelles qui relèvent du même mouvement de fond ` +
    `(ex. "La bataille des frontier models et des benchmarks", "Entrée en bourse des labs d'IA"). ` +
    `Pour chaque macro-tendance : un titre percutant en FRANÇAIS, un résumé de 2 à 4 phrases en FRANÇAIS qui raconte ` +
    `l'évolution sur la période, un thème (cyber, ia, tech, business, autre), un score d'importance 0-100, ` +
    `et item_ids = les ids des tendances mensuelles regroupées. ` +
    `Une tendance mensuelle PEUT alimenter plusieurs macro-tendances si pertinent.`;
  const lines = monthlyTrends.map((t) =>
    `${t.id} | ${(t as any).month} | ${t.article_count} articles | ${t.title} — ${(t.summary ?? '').slice(0, 200)}`
  );
  const user = `Tendances mensuelles de la période :\n${lines.join('\n')}`;

  const result = await llmTrends(env, system, user);
  const validIds = new Set(monthlyTrends.map((t) => t.id));
  const macro = sanitize(result.trends, validIds, maxTrends);

  // 3. Rattacher les articles : union des articles des tendances mensuelles membres.
  const articleMap = new Map<number, Map<number, number>>();
  for (let t = 0; t < macro.length; t++) {
    const map = new Map<number, number>();
    if (macro[t].item_ids.length) {
      const arts = await selectIn<{ article_id: number; weight: number }>(
        env, 'SELECT article_id, weight FROM trend_articles WHERE trend_id IN', macro[t].item_ids
      );
      for (const a of arts) map.set(a.article_id, Math.max(map.get(a.article_id) ?? 0, a.weight));
    }
    articleMap.set(t, map);
  }
  const articleCount = monthlySets.reduce((n, s) => n + s.set.article_count, 0);

  return await persistSet(env, windowKey, start, end, macro, articleCount, result.provider, result.model, articleMap);
}

function monthsBetween(start: number, end: number): string[] {
  const out: string[] = [];
  const d = new Date(start * 1000);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  while (Date.UTC(y, m, 1) / 1000 < end) {
    out.push(`month:${y}-${String(m + 1).padStart(2, '0')}`);
    m++;
    if (m === 12) { m = 0; y++; }
  }
  return out;
}

// ---------------------------------------------------------------- commun

function sanitize(trends: LlmTrend[], validIds: Set<number>, max: number): LlmTrend[] {
  return trends
    .map((t) => ({ ...t, item_ids: [...new Set(t.item_ids)].filter((id) => validIds.has(id)) }))
    .filter((t) => t.item_ids.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

async function selectIn<T>(env: Env, sqlPrefix: string, ids: number[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const sql = `${sqlPrefix} (${chunk.map(() => '?').join(',')})`;
    const res = await env.DB.prepare(sql).bind(...chunk).all<T>();
    out.push(...res.results);
  }
  return out;
}

async function persistSet(
  env: Env, windowKey: string, start: number, end: number,
  trends: LlmTrend[], articleCount: number, provider: string, model: string,
  articleMap: Map<number, Map<number, number>>
): Promise<ComputedSet> {
  // Remplace les sets existants de cette fenêtre (bornes proches).
  await env.DB.prepare(
    `DELETE FROM trend_sets WHERE window_key = ? AND period_start BETWEEN ? AND ? AND period_end BETWEEN ? AND ?`
  ).bind(windowKey, start - DAY, start + DAY, end - DAY, end + DAY).run();

  const setRes = await env.DB.prepare(
    `INSERT INTO trend_sets (window_key, period_start, period_end, article_count, provider, model)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(windowKey, start, end, articleCount, provider, model).first<TrendSetRow>();
  const set = setRes!;

  const trendRows: TrendRow[] = [];
  for (let i = 0; i < trends.length; i++) {
    const t = trends[i];
    const articles = articleMap.get(i) ?? new Map<number, number>();
    const row = await env.DB.prepare(
      `INSERT INTO trends (set_id, rank, title, summary, theme, score, article_count)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(set.id, i + 1, t.title, t.summary, t.theme, t.score, articles.size).first<TrendRow>();
    trendRows.push(row!);
    const stmt = env.DB.prepare('INSERT OR IGNORE INTO trend_articles (trend_id, article_id, weight) VALUES (?, ?, ?)');
    const batch = [...articles].map(([aid, w]) => stmt.bind(row!.id, aid, w));
    for (let j = 0; j < batch.length; j += 100) await env.DB.batch(batch.slice(j, j + 100));
  }
  return { set, trends: trendRows };
}

/** Recalcule les fenêtres standard courtes + le mois courant (cron quotidien). */
export async function refreshDaily(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const key of ['7d', '30d']) {
    const b = windowBounds(key, now);
    await computeSet(env, key, b.start, b.end);
  }
  const d = new Date(now * 1000);
  const mk = `month:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const mb = windowBounds(mk, now);
  if (mb.end > mb.start) await computeSet(env, mk, mb.start, mb.end);
}

/** Recalcule les fenêtres longues (cron hebdomadaire). */
export async function refreshLong(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const key of ['180d', '365d']) {
    const b = windowBounds(key, now);
    await computeSet(env, key, b.start, b.end);
  }
}
