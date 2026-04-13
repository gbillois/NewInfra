import { listFeeds } from "../../_lib/db.js";

// GET /api/feeds      → list all feeds
// POST /api/feeds     → add a feed { url, name }
export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) {
    return Response.json({ error: "DB binding missing" }, { status: 500 });
  }
  try {
    if (request.method === "GET") {
      const feeds = await listFeeds(env.DB);
      return Response.json({ feeds });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || !body.url || !body.name) {
        return Response.json(
          { error: "body must include { url, name }" },
          { status: 400 },
        );
      }
      try {
        new URL(body.url);
      } catch {
        return Response.json({ error: "invalid url" }, { status: 400 });
      }
      await env.DB.prepare(
        `INSERT INTO feeds (url, name, enabled) VALUES (?1, ?2, 1)
         ON CONFLICT(url) DO UPDATE SET name = excluded.name, enabled = 1`,
      )
        .bind(body.url, body.name)
        .run();
      const feeds = await listFeeds(env.DB);
      return Response.json({ feeds });
    }
    return new Response("Method Not Allowed", { status: 405 });
  } catch (err) {
    return Response.json({ error: String(err.message || err) }, { status: 500 });
  }
}
