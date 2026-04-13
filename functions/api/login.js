// POST /api/login      { password }  → issues a signed session cookie
// GET  /api/login                     → returns whether auth is enabled
//                                        and whether the caller is
//                                        authenticated (used by the
//                                        login page to auto-skip when
//                                        auth is disabled).

import {
  checkPassword,
  issueSession,
  sessionCookieHeader,
  isAuthenticated,
} from "../_lib/auth.js";

export async function onRequest({ request, env }) {
  if (request.method === "GET") {
    return Response.json({
      auth_enabled: Boolean(env.APP_PASSWORD),
      authenticated: await isAuthenticated(request, env),
    });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!env.APP_PASSWORD) {
    // Nothing to authenticate against. Return a noop success so the
    // client doesn't loop on the login page.
    return Response.json({ ok: true, auth_enabled: false });
  }

  const body = await request.json().catch(() => null);
  const pwd = body && typeof body.password === "string" ? body.password : "";
  if (!checkPassword(pwd, env.APP_PASSWORD)) {
    // Tiny delay to blunt naive brute-force; real rate-limiting is on
    // the Cloudflare side (WAF rules) if you need it.
    await new Promise((r) => setTimeout(r, 400));
    return Response.json({ error: "invalid password" }, { status: 401 });
  }

  const { token, maxAge } = await issueSession(env.APP_PASSWORD);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": sessionCookieHeader(token, maxAge),
    },
  });
}
