// POST /api/refresh  { period: "day"|"week"|"fortnight"|"month",
//                      collect?: boolean }
// Public endpoint called by the "Rafraîchir" button in the UI.
// - If `collect` is true (default), fetches every enabled feed first.
// - Then regenerates the synthesis for the requested period.
// A simple server-side cooldown (30s per period) prevents accidental
// double-clicks from triggering repeat LLM calls.

import { collectAllFeeds } from "../_lib/collect.js";
import { synthesizePeriod } from "../_lib/synthesize.js";
import { isValidPeriod, periodBounds } from "../_lib/period.js";
import { getSynthesis } from "../_lib/db.js";

const COOLDOWN_SECS = 30;

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!env.DB) {
    return Response.json({ error: "DB binding missing" }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const period = body.period || "day";
  if (!isValidPeriod(period)) {
    return Response.json({ error: "invalid period" }, { status: 400 });
  }
  const doCollect = body.collect !== false;

  const bounds = periodBounds(period);
  const existing = await getSynthesis(env.DB, period, bounds.start);
  if (existing && existing.created_at) {
    const age = Math.floor(Date.now() / 1000) - existing.created_at;
    if (age < COOLDOWN_SECS) {
      return Response.json(
        {
          error: `cooldown: synthesis regenerated ${age}s ago; retry in ${COOLDOWN_SECS - age}s`,
          retry_after: COOLDOWN_SECS - age,
        },
        { status: 429 },
      );
    }
  }

  const t0 = Date.now();
  let collectReport = null;
  if (doCollect) {
    collectReport = await collectAllFeeds(env);
  }

  try {
    const synth = await synthesizePeriod(env, period);
    return Response.json({
      elapsed_ms: Date.now() - t0,
      collect: collectReport && {
        feeds_processed: collectReport.length,
        inserted: collectReport.reduce((s, r) => s + (r.inserted || 0), 0),
        errors: collectReport.filter((r) => !r.ok).map((r) => ({
          feed: r.name,
          error: r.error,
        })),
      },
      synthesis: synth,
    });
  } catch (err) {
    return Response.json(
      { error: String(err.message || err), collect: collectReport },
      { status: 500 },
    );
  }
}
