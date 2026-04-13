// POST /api/cron/synthesize?period=day|week|fortnight|month
// Runs the LLM synthesis for the given period. Same CRON_SECRET
// protection as /api/cron/collect.

import { synthesizePeriod } from "../../_lib/synthesize.js";
import { isValidPeriod } from "../../_lib/period.js";

function checkSecret(request, env) {
  if (!env.CRON_SECRET) return true;
  const got = request.headers.get("x-cron-secret");
  return got && got === env.CRON_SECRET;
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!checkSecret(request, env)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!env.DB) {
    return Response.json({ error: "DB binding missing" }, { status: 500 });
  }

  const url = new URL(request.url);
  const period = url.searchParams.get("period") || "day";
  if (!isValidPeriod(period)) {
    return Response.json({ error: "invalid period" }, { status: 400 });
  }

  try {
    const res = await synthesizePeriod(env, period);
    return Response.json(res);
  } catch (err) {
    return Response.json(
      { error: String(err.message || err) },
      { status: 500 },
    );
  }
}
