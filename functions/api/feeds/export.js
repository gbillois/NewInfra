// GET /api/feeds/export?format=opml|json
// Produce an OPML (for RSS readers) or JSON export of all feeds. The
// JSON shape matches what /api/feeds/import accepts, so export+import
// is a round-trip.

export async function onRequest({ request, env }) {
  if (!env.DB) {
    return Response.json({ error: "DB binding missing" }, { status: 500 });
  }
  const url = new URL(request.url);
  const format = (url.searchParams.get("format") || "opml").toLowerCase();

  const { results } = await env.DB.prepare(
    "SELECT url, name, enabled FROM feeds ORDER BY name COLLATE NOCASE",
  ).all();

  if (format === "json") {
    return new Response(JSON.stringify({ feeds: results }, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="feeds.json"`,
      },
    });
  }

  const escape = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const items = results
    .map(
      (f) =>
        `    <outline type="rss" text="${escape(f.name)}" title="${escape(f.name)}" xmlUrl="${escape(f.url)}"/>`,
    )
    .join("\n");
  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>NewInfra cyber news feeds</title>
  </head>
  <body>
${items}
  </body>
</opml>
`;

  return new Response(opml, {
    headers: {
      "content-type": "text/x-opml; charset=utf-8",
      "content-disposition": `attachment; filename="feeds.opml"`,
    },
  });
}
