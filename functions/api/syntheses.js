// GET /api/syntheses?period=day|week|fortnight|month&ref=<epoch_sec?>
// Returns the stored synthesis for that period's current window, plus
// a count of articles in the window (so the UI can show "N articles
// ingested but no synthesis yet").

import { periodBounds, isValidPeriod } from "../_lib/period.js";
import { getSynthesis } from "../_lib/db.js";

export async function onRequest({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "DB binding missing" }, { status: 500 });
  }
  const url = new URL(request.url);
  const period = url.searchParams.get("period") || "day";
  if (!isValidPeriod(period)) {
    return Response.json({ error: "invalid period" }, { status: 400 });
  }
  const ref = Number(url.searchParams.get("ref")) || undefined;
  const bounds = periodBounds(period, ref);

  const synthesis = await getSynthesis(env.DB, period, bounds.start);
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM articles
      WHERE COALESCE(published_at, fetched_at) BETWEEN ?1 AND ?2`,
  )
    .bind(bounds.start, bounds.end)
    .first();

  return Response.json({
    period,
    period_start: bounds.start,
    period_end: bounds.end,
    article_count_in_window: countRow?.c ?? 0,
    synthesis,
  });
}
