// Tiny auth helper. APP_PASSWORD is the only secret — there is no
// separate session store and no separate signing key. On login we set
// a cookie whose value is SHA-256(APP_PASSWORD). Middleware recomputes
// the hash on every request and compares in constant time.
//
// Rotating APP_PASSWORD invalidates every outstanding cookie (which is
// the behaviour you want after a leak). Session lifetime is bounded by
// the cookie's Max-Age.

const SESSION_TTL_SECS = 30 * 24 * 3600; // 30 days

async function hashPassword(password) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(password)),
  );
  let hex = "";
  for (const b of new Uint8Array(buf)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// Constant-time string compare — avoids timing oracles on the shared
// password and on the session hash.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function issueSession(password) {
  return { token: await hashPassword(password), maxAge: SESSION_TTL_SECS };
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
  return [
    `session=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearSessionCookieHeader() {
  return "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

export function checkPassword(submitted, expected) {
  if (!expected) return false;
  return timingSafeEqual(String(submitted || ""), String(expected));
}

// Is the given request authenticated? Fail-open when APP_PASSWORD is
// unset (so first-time deploys are usable before the operator has
// configured the secret); otherwise the `session` cookie must equal
// SHA-256(APP_PASSWORD).
export async function isAuthenticated(request, env) {
  if (!env || !env.APP_PASSWORD) return true;
  const token = getCookie(request, "session");
  if (!token) return false;
  const expected = await hashPassword(env.APP_PASSWORD);
  return timingSafeEqual(token, expected);
}
