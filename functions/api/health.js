// GET /api/health → minimal liveness probe used by the CI smoke test.
// Intentionally public (whitelisted in functions/_middleware.js) so the
// smoke check keeps working after APP_PASSWORD is set.
export async function onRequest({ env }) {
  const dbOk = Boolean(env.DB);
  return Response.json({
    ok: true,
    db: dbOk,
    auth_enabled: Boolean(env.APP_PASSWORD),
  });
}
