// Password hashing + session cookies via WebCrypto only (no deps).
// PBKDF2 iteration count is modest: the free plan allows ~10ms CPU per
// request, and the password is not the only lock — claiming needs the
// one-time code, and stealing the stored hash already means DO compromise.

const enc = new TextEncoder();

export const bytesToHex = (b) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export const hexToBytes = (h) =>
  new Uint8Array(h.match(/.{2}/g).map((x) => parseInt(x, 16)));

export async function hashPassword(password, saltHex, iterations = 10000) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return { saltHex: bytesToHex(salt), hashHex: bytesToHex(bits), iterations };
}

export async function verifyPassword(password, stored) {
  const { hashHex } = await hashPassword(password, stored.saltHex, stored.iterations);
  // constant-time-ish compare
  if (hashHex.length !== stored.hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hashHex.length; i++)
    diff |= hashHex.charCodeAt(i) ^ stored.hashHex.charCodeAt(i);
  return diff === 0;
}

async function hmac(secretHex, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function mintSession(secretHex) {
  const exp = Date.now() + SESSION_TTL_MS;
  return exp + "." + (await hmac(secretHex, "session:" + exp));
}

export async function verifySession(secretHex, token) {
  if (!secretHex || !token) return false;
  const [expStr, sig] = String(token).split(".");
  const exp = Number(expStr);
  if (!exp || exp < Date.now()) return false;
  return (await hmac(secretHex, "session:" + expStr)) === sig;
}

export function sessionCookie(token) {
  return `sb_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}`;
}

export function readSessionCookie(request) {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)sb_session=([^;]+)/);
  return m ? m[1] : null;
}
