/**
 * Signed session cookie helpers.
 *
 * Runs on BOTH:
 *   • Edge Runtime (middleware.ts — verifies cookie on every gated
 *     request; can't use Node crypto, must use Web Crypto)
 *   • Node runtime (app/login/actions.ts — signs a fresh cookie after
 *     a successful password check; could use Node crypto but sharing
 *     one helper is simpler)
 *
 * Web Crypto's HMAC-SHA256 works identically in both environments,
 * so we deliberately don't import `node:crypto` anywhere.
 *
 * Token format
 * ------------
 *   <base64url(payload)>.<base64url(hmac)>
 *
 * payload = { exp: <unix-seconds> }
 *
 * The payload is not encrypted — an attacker who steals the cookie can
 * see the expiry timestamp. That's fine (expiry alone is not sensitive).
 * They CAN'T forge a new cookie without APP_SESSION_SECRET, and they
 * CAN'T extend the expiry of an existing one because the HMAC would
 * no longer match.
 *
 * Not JWT because JWT adds a header field, alg negotiation, and a
 * long history of implementation bugs (alg=none, key confusion, etc.)
 * for zero benefit in a single-issuer single-verifier scenario.
 */

export const SESSION_COOKIE = "vayu-session";

/** 30 days — long enough that you don't re-login every workday, short
 * enough that a stolen phone doesn't stay logged in for a year. */
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

// ─── base64url helpers ─────────────────────────────────────────────
// Standard base64 uses "+", "/", "=" — all of which need URL-encoding
// when they land in a cookie or query string. base64url swaps them for
// URL-safe equivalents ("-", "_", stripped "=") per RFC 4648 §5.
//
// Both middleware (Edge) and server actions (Node) expose btoa/atob
// on the global, so we don't need Buffer here.

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  // Restore padding — atob is strict about it in some runtimes.
  const pad = "===".slice((str.length + 3) % 4);
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Sign a new session token that expires at `expiresAtMs` (JS epoch ms).
 * Server action call site is the ONLY writer — never sign from client
 * code because that would require exposing the secret to the browser.
 */
export async function signSession(
  secret: string,
  expiresAtMs: number
): Promise<string> {
  const payload = JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) });
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64)
  );
  return `${payloadB64}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify a token's HMAC + expiry. Returns true only if BOTH:
 *   1. Signature matches (proves token was minted with our secret)
 *   2. exp > now (token hasn't expired)
 *
 * Any parse failure, any tampering, any missing field → false. Never
 * throws; callers just get boolean and redirect on false.
 */
export async function verifySession(
  token: string,
  secret: string
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;

  let payload: { exp?: unknown };
  try {
    const payloadJson = new TextDecoder().decode(b64urlDecode(payloadB64));
    payload = JSON.parse(payloadJson);
  } catch {
    return false;
  }
  if (typeof payload.exp !== "number") return false;
  if (payload.exp * 1000 < Date.now()) return false;

  try {
    const key = await hmacKey(secret);
    const sig = b64urlDecode(sigB64);
    // Cast to BufferSource: crypto.subtle.verify's ES2024 lib.d.ts
    // signature demands `Uint8Array<ArrayBuffer>` (a tight backing
    // store) while our decode helper returns `Uint8Array<ArrayBufferLike>`
    // — the two are structurally equivalent at runtime, TS just can't
    // prove the SharedArrayBuffer branch away. Cast is safe: atob's
    // output is always a plain ArrayBuffer-backed Uint8Array.
    return await crypto.subtle.verify(
      "HMAC",
      key,
      sig as BufferSource,
      new TextEncoder().encode(payloadB64)
    );
  } catch {
    return false;
  }
}
