// Tiny auth helper: sign/verify a session token with HMAC-SHA256.
// The signing key is APP_PASSWORD itself — no separate session secret
// to manage. Token format: "<expiry>.<b64url(hmac)>" where expiry is
// a unix timestamp (seconds). Stored in the Cookie header as `session=...`.
//
// We intentionally keep this stateless (no server-side session table):
// rotating APP_PASSWORD invalidates every existing session, which is
// the behaviour you want after a leak.

const SESSION_TTL_SECS = 30 * 24 * 3600; // 30 days

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(msg),
  );
  return b64urlEncode(new Uint8Array(sig));
}

// Constant-time string compare to avoid timing oracles on the shared
// password and on the HMAC output.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function issueSession(password) {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECS;
  const sig = await hmac(password, String(expiry));
  return { token: `${expiry}.${sig}`, maxAge: SESSION_TTL_SECS };
}

export async function verifySession(token, password) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const expiry = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expected = await hmac(password, String(expiry));
  return timingSafeEqual(sig, expected);
}

export function getCookie(request, name) {
  const hdr = request.headers.get("cookie") || "";
  for (const part of hdr.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export function sessionCookieHeader(token, maxAge) {
  const attrs = [
    `session=${token}`,
    `Path=/`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
    `Max-Age=${maxAge}`,
  ];
  return attrs.join("; ");
}

export function clearSessionCookieHeader() {
  return "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

export function checkPassword(submitted, expected) {
  if (!expected) return false;
  return timingSafeEqual(String(submitted || ""), String(expected));
}

// Is the given request authenticated? Returns true when APP_PASSWORD is
// unset (fail-open, lets first-time deployments work) OR the session
// cookie HMAC verifies.
export async function isAuthenticated(request, env) {
  if (!env.APP_PASSWORD) return true;
  const token = getCookie(request, "session");
  if (!token) return false;
  return verifySession(token, env.APP_PASSWORD);
}
