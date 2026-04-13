// POST /api/cron/collect
// Ingests every enabled feed. Called by the GitHub Actions cron
// workflow. If the CRON_SECRET environment secret is set on the
// deployment, requests must include `x-cron-secret` matching it.

import { collectAllFeeds } from "../../_lib/collect.js";

function checkSecret(request, env) {
  if (!env.CRON_SECRET) return true; // fail-open when not configured
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

  const t0 = Date.now();
  const report = await collectAllFeeds(env);
  return Response.json({
    elapsed_ms: Date.now() - t0,
    feeds_processed: report.length,
    inserted: report.reduce((s, r) => s + (r.inserted || 0), 0),
    report,
  });
}
