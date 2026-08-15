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

// ---------------------------------------------------------------- passkeys
// WebAuthn verification on bare WebCrypto — no CBOR, no deps. The client
// sends what the modern browser API hands it directly (getPublicKey() SPKI,
// getAuthenticatorData()); the server independently verifies the ceremony:
// challenge (single-use, DO-stored), origin, rpIdHash, user-presence flag,
// and on login the signature over authenticatorData || SHA-256(clientDataJSON).

export const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
};

export const randomB64u = (n = 32) => b64u.enc(crypto.getRandomValues(new Uint8Array(n)));

const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest("SHA-256", u8));

// WebAuthn ECDSA signatures arrive ASN.1/DER; WebCrypto verifies raw r||s.
function derSigToRaw(der) {
  let o = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const readInt = () => {
    if (der[o++] !== 0x02) throw new Error("malformed DER signature");
    let len = der[o++];
    let v = der.slice(o, o + len);
    o += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error("malformed DER signature");
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = readInt(), s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r); raw.set(s, 32);
  return raw;
}

function importPasskey(publicKeyB64u, alg) {
  const spki = b64u.dec(publicKeyB64u);
  if (alg === -7) return crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (alg === -257) return crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  throw new Error("unsupported passkey algorithm " + alg);
}

async function assertAuthData(ad, rpId) {
  if (!(ad instanceof Uint8Array) || ad.length < 37) throw new Error("malformed authenticatorData");
  const h = await sha256(enc.encode(rpId));
  for (let i = 0; i < 32; i++) if (ad[i] !== h[i]) throw new Error("rpId mismatch");
  if (!(ad[32] & 0x01)) throw new Error("user-presence flag not set");
}

const adCounter = (ad) => ((ad[33] << 24) | (ad[34] << 16) | (ad[35] << 8) | ad[36]) >>> 0;

function parseClientData(cred, expectedType, expectedChallenge, origin) {
  const cd = JSON.parse(new TextDecoder().decode(b64u.dec(cred.clientDataJSON)));
  if (cd.type !== expectedType) throw new Error("wrong ceremony type");
  if (!expectedChallenge || cd.challenge !== expectedChallenge) throw new Error("challenge mismatch or expired");
  if (cd.origin !== origin) throw new Error("origin mismatch");
}

// Registration: validate the ceremony and return the credential to store.
// The key is import-checked NOW so a junk key fails at enrollment, not at
// the moment the user is locked out and trying to log in.
export async function verifyPasskeyRegistration({ cred, expectedChallenge, origin, rpId }) {
  parseClientData(cred, "webauthn.create", expectedChallenge, origin);
  const ad = b64u.dec(cred.authenticatorData);
  await assertAuthData(ad, rpId);
  const alg = Number(cred.alg);
  await importPasskey(cred.publicKey, alg);
  return { id: String(cred.id), publicKey: String(cred.publicKey), alg, counter: adCounter(ad), addedAt: Date.now() };
}

// Login: verify the assertion signature against the stored credential.
// Counter is a soft check — many platform passkeys report 0 forever, so only
// a regression between two NONZERO values is treated as cloning evidence.
export async function verifyPasskeyAssertion({ cred, stored, expectedChallenge, origin, rpId }) {
  parseClientData(cred, "webauthn.get", expectedChallenge, origin);
  const ad = b64u.dec(cred.authenticatorData);
  await assertAuthData(ad, rpId);
  const key = await importPasskey(stored.publicKey, stored.alg);
  const cdHash = await sha256(b64u.dec(cred.clientDataJSON));
  const data = new Uint8Array(ad.length + 32);
  data.set(ad); data.set(cdHash, ad.length);
  let sig = b64u.dec(cred.signature);
  if (stored.alg === -7) sig = derSigToRaw(sig);
  const params = stored.alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5";
  if (!(await crypto.subtle.verify(params, key, sig, data))) throw new Error("signature invalid");
  const counter = adCounter(ad);
  if (stored.counter > 0 && counter > 0 && counter <= stored.counter) throw new Error("authenticator counter regression");
  return { counter };
}

// Live claim-code comparison (the code doubles as the fallback login):
// compare digests so length isn't leaked; not perfectly constant-time, but
// the comparison is between hashes, not the secrets.
export async function secretsMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const [ha, hb] = await Promise.all([sha256(enc.encode(a)), sha256(enc.encode(b))]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}
