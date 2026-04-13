import { listFeeds } from "../../_lib/db.js";

// DELETE /api/feeds/:id        → remove a feed (and its articles via FK)
// PATCH  /api/feeds/:id {enabled|name|url}  → toggle / rename / change URL
export async function onRequest(context) {
  const { request, env, params } = context;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }
  if (!env.DB) {
    return Response.json({ error: "DB binding missing" }, { status: 500 });
  }

  try {
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM feeds WHERE id = ?1").bind(id).run();
      return Response.json({ feeds: await listFeeds(env.DB) });
    }
    if (request.method === "PATCH") {
      const body = await request.json().catch(() => ({}));
      const sets = [];
      const binds = [];
      if (typeof body.enabled === "boolean") {
        sets.push(`enabled = ?${binds.length + 1}`);
        binds.push(body.enabled ? 1 : 0);
      }
      if (typeof body.name === "string" && body.name.trim()) {
        sets.push(`name = ?${binds.length + 1}`);
        binds.push(body.name.trim());
      }
      if (typeof body.url === "string" && body.url.trim()) {
        try {
          new URL(body.url);
        } catch {
          return Response.json({ error: "invalid url" }, { status: 400 });
        }
        sets.push(`url = ?${binds.length + 1}`);
        binds.push(body.url.trim());
      }
      if (!sets.length) {
        return Response.json({ error: "nothing to update" }, { status: 400 });
      }
      binds.push(id);
      await env.DB.prepare(
        `UPDATE feeds SET ${sets.join(", ")} WHERE id = ?${binds.length}`,
      )
        .bind(...binds)
        .run();
      return Response.json({ feeds: await listFeeds(env.DB) });
    }
    return new Response("Method Not Allowed", { status: 405 });
  } catch (err) {
    return Response.json({ error: String(err.message || err) }, { status: 500 });
  }
}
