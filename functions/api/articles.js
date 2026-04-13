// GET /api/articles?period=day|week|fortnight|month&ref=<epoch?>&ids=1,2,3
// If `ids` is given, returns those specific articles (used to render
// the "sources" panel alongside a synthesis).
// Otherwise returns the articles in the requested period window.

import { periodBounds, isValidPeriod } from "../_lib/period.js";
import { articlesInRange } from "../_lib/db.js";

export async function onRequest({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "DB binding missing" }, { status: 500 });
  }
  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids");

  if (idsParam) {
    const ids = idsParam
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 500);
    if (!ids.length) return Response.json({ articles: [] });
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.url, a.title, a.author, a.summary, a.published_at,
              f.name AS feed_name
         FROM articles a JOIN feeds f ON f.id = a.feed_id
        WHERE a.id IN (${placeholders})
        ORDER BY COALESCE(a.published_at, a.fetched_at) DESC`,
    )
      .bind(...ids)
      .all();
    return Response.json({ articles: results });
  }

  const period = url.searchParams.get("period") || "day";
  if (!isValidPeriod(period)) {
    return Response.json({ error: "invalid period" }, { status: 400 });
  }
  const ref = Number(url.searchParams.get("ref")) || undefined;
  const bounds = periodBounds(period, ref);
  const articles = await articlesInRange(env.DB, bounds.start, bounds.end, { limit: 400 });
  return Response.json({
    period,
    period_start: bounds.start,
    period_end: bounds.end,
    articles,
  });
}
