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

import { clearSessionCookieHeader, getCookie, isAuthenticated } from "./_lib/auth.js";

const LOGIN_PATH = "/login.html";
const PUBLIC_API = new Set(["/api/login", "/api/logout", "/api/health"]);
const PUBLIC_HTML = new Set([LOGIN_PATH]);
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

// Build a safe `next` value for the login redirect.
// We only ever round-trip a same-origin path+query and we explicitly
// refuse paths that would land back on the login page — that is the
// classic shape of a redirect loop ("too many redirects" in the browser).
function safeNext(pathname, search) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return "/";
  // Reject protocol-relative ("//evil.com") and backslash tricks that
  // some browsers normalise to "//".
  if (pathname.startsWith("//") || pathname.startsWith("/\\")) return "/";
  if (pathname === LOGIN_PATH) return "/";
  return pathname + (search || "");
}

export async function onRequest({ request, env, next }) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (isPublic(url.pathname)) return next();

  let authed = false;
  try {
    authed = await isAuthenticated(request, env);
  } catch (err) {
    // A crash inside the verifier (malformed cookie, crypto failure, …)
    // must not 5xx the whole site. Treat it as "not authenticated" and
    // proactively clear the bad cookie so the next request stops looping
    // through the same broken state.
    return unauthenticated(request, url, { clearStaleCookie: true });
  }
  if (authed) return next();

  return unauthenticated(request, url, {
    clearStaleCookie: Boolean(getCookie(request, "session")),
  });
}

function unauthenticated(request, url, { clearStaleCookie }) {
  // HTML navigations: bounce to the login page with a sanitised `next`
  // pointer. Anything else (XHR/fetch/JSON consumers) gets a 401 so the
  // client can react without following an unexpected redirect.
  const isHtmlNav = request.method === "GET" && wantsHtml(request);

  const headers = new Headers();
  if (clearStaleCookie) headers.append("set-cookie", clearSessionCookieHeader());

  if (isHtmlNav) {
    const redirect = new URL(LOGIN_PATH, url);
    redirect.searchParams.set("next", safeNext(url.pathname, url.search));
    headers.set("location", redirect.toString());
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers });
  }

  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers,
  });
}
