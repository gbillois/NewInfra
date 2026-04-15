// GET /api/syntheses?period=day|week|fortnight|month
//                   &mode=llm|vector-raw|vector-narrative  (default: llm)
//                   &ref=<epoch_sec?>
// Returns the stored synthesis for that (period, mode) current window,
// plus a count of articles in the window (so the UI can show
// "N articles ingested but no synthesis yet").

import { periodBounds, isValidPeriod } from "../_lib/period.js";
import { getSynthesis } from "../_lib/db.js";

const VALID_MODES = new Set(["llm", "vector-raw", "vector-narrative"]);

export async function onRequest({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "DB binding missing" }, { status: 500 });
  }
  const url = new URL(request.url);
  const period = url.searchParams.get("period") || "day";
  if (!isValidPeriod(period)) {
    return Response.json({ error: "invalid period" }, { status: 400 });
  }
  const mode = url.searchParams.get("mode") || "llm";
  if (!VALID_MODES.has(mode)) {
    return Response.json({ error: "invalid mode" }, { status: 400 });
  }
  const ref = Number(url.searchParams.get("ref")) || undefined;
  const bounds = periodBounds(period, ref);

  const synthesis = await getSynthesis(env.DB, period, bounds.start, mode);
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM articles
      WHERE COALESCE(published_at, fetched_at) BETWEEN ?1 AND ?2`,
  )
    .bind(bounds.start, bounds.end)
    .first();

  return Response.json({
    period,
    mode,
    period_start: bounds.start,
    period_end: bounds.end,
    article_count_in_window: countRow?.c ?? 0,
    synthesis,
  });
}
