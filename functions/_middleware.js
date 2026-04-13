// TEMPORARY: auth gate disabled.
//
// The full middleware (cookie-based session check, redirect to
// /login.html on HTML navigations, 401 on API calls) is preserved in
// git history and in functions/_lib/auth.js. To restore it, revert
// this file to its previous version.
//
// While disabled, every request is let through unchanged. CRON_SECRET
// protection on /api/cron/* is unaffected (it lives inside those
// handlers, not in this middleware).

export async function onRequest({ next }) {
  return next();
}
