// Global auth gate for the whole Pages app.
// - If APP_PASSWORD is not set on the deployment, the gate is disabled
//   (fail-open). This matches the CRON_SECRET behaviour and keeps the
//   first deploy usable before the operator has configured the secret.
// - Otherwise, requests must carry a valid `session=` cookie issued by
//   POST /api/login.
//
// Public paths that MUST stay reachable while unauthenticated:
//   /login.html, /api/login, /api/logout  → otherwise no one can log in
//   /api/cron/*                           → protected by CRON_SECRET
//   /api/health                           → used by the CI smoke test
//   *.css, *.js, *.ico, *.svg, *.png, *.webmanifest, fonts
//     → static assets needed to render /login.html (and harmless: they
//       contain no secrets; the client code only reacts to JSON from
//       /api/* which is gated anyway).

import { isAuthenticated } from "./_lib/auth.js";

const PUBLIC_API = new Set(["/api/login", "/api/logout", "/api/health"]);
const PUBLIC_HTML = new Set(["/login.html"]);
const STATIC_EXT = /\.(css|js|mjs|ico|svg|png|jpg|jpeg|gif|webp|woff2?|ttf|webmanifest|map)$/i;

function isPublic(pathname) {
  if (PUBLIC_HTML.has(pathname)) return true;
  if (PUBLIC_API.has(pathname)) return true;
  if (pathname.startsWith("/api/cron/")) return true;
  if (STATIC_EXT.test(pathname)) return true;
  return false;
}

function wantsHtml(request) {
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (isPublic(url.pathname)) return next();

  if (await isAuthenticated(request, env)) return next();

  // Unauthenticated. For HTML navigations, redirect to the login page
  // and preserve the intended destination as ?next=… so the login flow
  // can bring the user back after success.
  if (request.method === "GET" && wantsHtml(request)) {
    const redirect = new URL("/login.html", url);
    redirect.searchParams.set("next", url.pathname + url.search);
    return Response.redirect(redirect.toString(), 302);
  }

  return Response.json({ error: "unauthorized" }, { status: 401 });
}
