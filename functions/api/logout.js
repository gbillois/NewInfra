// POST /api/logout → clears the session cookie. Stateless: we don't
// track sessions server-side, so "logout" is just cookie deletion.

import { clearSessionCookieHeader } from "../_lib/auth.js";

export async function onRequest({ request }) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": clearSessionCookieHeader(),
    },
  });
}
