export async function onRequest(context) {
  try {
    if (!context.env.DB) {
      return Response.json(
        { error: "D1 binding 'DB' is not configured" },
        { status: 500 },
      );
    }
    const { results } = await context.env.DB
      .prepare("SELECT text FROM content ORDER BY id LIMIT 1")
      .all();
    return Response.json({ text: results[0]?.text ?? "" });
  } catch (err) {
    return Response.json(
      { error: err.message ?? String(err) },
      { status: 500 },
    );
  }
}
