"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  signSession,
} from "@/lib/session";

/**
 * Validate submitted password against APP_PASSWORD; on success, sign a
 * fresh session cookie and redirect to `next` (or / by default).
 *
 * Sign-in failure UX
 * ------------------
 * On bad password we redirect back to /login with ?error=... in the
 * URL. That plays nicely with React 19's form actions (no client-side
 * state to hydrate) AND with a browser reload — the URL itself carries
 * the error, so a refresh doesn't blank the message.
 *
 * `next` handling
 * ---------------
 * We deliberately narrow `next` to same-origin relative paths starting
 * with a single "/" — this prevents an attacker who tricks you into
 * clicking `/login?next=//evil.com/steal` from bouncing you off-site
 * after login (open-redirect class of bugs). Any suspicious value
 * silently falls back to "/".
 */

function safeNextPath(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  // Must start with exactly one "/" — "//" is protocol-relative and
  // would let an attacker send you off-origin.
  if (!s.startsWith("/") || s.startsWith("//")) return "/";
  // Reject backslash tricks that some browsers normalise to "/".
  if (s.includes("\\")) return "/";
  return s;
}

// Timing-safe string comparison built on Web Crypto. Node's
// `crypto.timingSafeEqual` isn't available on the Node runtime here
// without adding an import that could accidentally get pulled into the
// middleware bundle (Edge Runtime rejects `node:crypto`). Loop-XOR is
// well-known and adequate for a single-comparison-per-request path.
function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  // Length mismatch would leak length via early exit, so we still
  // walk the full max length and just AND-in the length check at
  // the end. Not perfect (an attacker can observe response TIME
  // varying with password length overall) but this is a single-user
  // dashboard, not a bank.
  const len = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  }
  return diff === 0;
}

export async function login(formData: FormData): Promise<void> {
  const submittedUser = String(formData.get("username") ?? "");
  const submittedPass = String(formData.get("password") ?? "");
  const nextPath = safeNextPath(formData.get("next"));

  const expectedUser = process.env.APP_USERNAME;
  const expectedPass = process.env.APP_PASSWORD;
  const secret = process.env.APP_SESSION_SECRET;

  const backToLogin = (msg: string): never => {
    const q = new URLSearchParams();
    if (nextPath !== "/") q.set("next", nextPath);
    q.set("error", msg);
    redirect(`/login?${q.toString()}`);
  };

  if (!expectedUser || !expectedPass || !secret) {
    backToLogin(
      "Server not configured — set APP_USERNAME, APP_PASSWORD, and APP_SESSION_SECRET in env vars."
    );
  }

  // Username is case-insensitive and whitespace-trimmed — matches
  // muscle memory ("Vayu" and "vayu" should both work) and dodges
  // password-manager autofill quirks that sometimes append a trailing
  // space. Password stays case-sensitive and whitespace-preserving
  // because it's supposed to be a random secret, not a name.
  const userOk = constantTimeEqual(
    submittedUser.trim().toLowerCase(),
    expectedUser!.trim().toLowerCase()
  );
  const passOk = constantTimeEqual(submittedPass, expectedPass!);

  // We compute both checks and combine with a bitwise-ish AND so the
  // response time doesn't reveal which field was wrong. Standard
  // "don't leak which of username / password is invalid" pattern:
  // returning the same generic error text is not enough on its own
  // if the code path short-circuits on the first mismatch.
  if (!(userOk && passOk)) {
    backToLogin("Invalid username or password");
  }

  const expiresAtMs = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const token = await signSession(secret!, expiresAtMs);

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, // JS can't read it — mitigates XSS token theft
    // HTTPS-only in production (Vercel). On local `next dev` over http,
    // secure cookies are dropped by the browser — so login appears to
    // succeed then bounce straight back to /login.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // OK for login form + top-level nav; blocks third-party POSTs
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });

  redirect(nextPath);
}

/**
 * Server action to sign OUT — clears the cookie and bounces you to
 * /login. Wired to the "Sign out" button in TopNav.
 *
 * We ONLY clear the cookie; there's no server-side session store to
 * invalidate. Because tokens are stateless HMAC blobs, a compromised
 * token remains valid until its `exp` field elapses — the only
 * server-side way to invalidate all outstanding tokens is to rotate
 * APP_SESSION_SECRET (which invalidates them ALL at once). For a
 * single-user tool that trade-off is fine.
 */
export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
