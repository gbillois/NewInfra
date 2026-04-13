// POST /api/feeds/import
// Accepts either an OPML upload (content-type text/xml or */xml) or a
// JSON body { feeds: [{url, name}] }. Inserts new feeds, ignores
// duplicates. Returns the resulting feed list.

import { listFeeds } from "../../_lib/db.js";

function parseOpml(xml) {
  const out = [];
  const re =
    /<outline\b[^>]*?\bxmlUrl="([^"]+)"[^>]*?(?:\btext="([^"]*)"|\btitle="([^"]*)")?[^>]*\/?>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const url = m[1];
    const name = (m[2] || m[3] || url).replace(/&amp;/g, "&").replace(/&quot;/g, '"');
    if (url) out.push({ url, name });
  }
  return out;
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!env.DB) {
    return Response.json({ error: "DB binding missing" }, { status: 500 });
  }

  const ct = (request.headers.get("content-type") || "").toLowerCase();
  let feeds = [];
  try {
    if (ct.includes("json")) {
      const body = await request.json();
      feeds = Array.isArray(body?.feeds) ? body.feeds : [];
    } else {
      const text = await request.text();
      feeds = parseOpml(text);
    }
  } catch (err) {
    return Response.json(
      { error: "could not parse body: " + String(err.message || err) },
      { status: 400 },
    );
  }

  let imported = 0;
  for (const f of feeds) {
    if (!f || !f.url || !f.name) continue;
    try {
      new URL(f.url);
    } catch {
      continue;
    }
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO feeds (url, name, enabled) VALUES (?1, ?2, 1)`,
    )
      .bind(f.url, f.name)
      .run();
    if (r.meta && r.meta.changes > 0) imported++;
  }
  return Response.json({ imported, total: feeds.length, feeds: await listFeeds(env.DB) });
}
