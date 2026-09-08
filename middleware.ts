import { NextResponse, type NextRequest } from "next/server";
// Relative import required for Edge: Vercel rejects the `@/` alias as an
// "unsupported module" when bundling middleware as an Edge Function.
import { SESSION_COOKIE, verifySession } from "./lib/session";

/**
 * Auth gate — runs on every request via the matcher below.
 * =========================================================
 *
 * The single-user password model
 * ------------------------------
 * Vayu has one owner (you). There is no user table, no signup, no
 * "forgot password" flow. Access is boolean: you either know
 * APP_PASSWORD (env var set in the Vercel dashboard) or you don't.
 *
 * On a successful password submit at /login, app/login/actions.ts
 * signs a session token with APP_SESSION_SECRET (HMAC-SHA256) and
 * drops it into a httpOnly cookie. This middleware verifies that
 * cookie on every subsequent request. A missing / invalid / expired
 * cookie → redirect to /login with the original path in `?next=`
 * so post-login lands you back where you were trying to go.
 *
 * Why middleware, not a Server Component check
 * --------------------------------------------
 * Middleware runs BEFORE the route handler/RSC render, on Edge
 * Runtime. A Server-Component-level check would still let the route
 * begin rendering (and hitting Supabase) before we could reject. For
 * a dashboard that does 20+ DB queries per page, that's 20+ wasted
 * queries per unauthenticated hit. Middleware short-circuits the
 * whole stack.
 *
 * The public allow-list
 * ---------------------
 * A few paths MUST be reachable without a session:
 *   • /login              — obviously
 *   • /manifest.webmanifest, /sw.js, /icon*, /apple-touch-icon.png,
 *     /icon.svg           — Chrome fetches these BEFORE the user has
 *                           a chance to log in, to decide whether the
 *                           site is PWA-installable. Blocking them
 *                           behind auth means the "Install app" prompt
 *                           never appears.
 *   • /favicon.ico        — browser tab icon, harmless.
 *
 * Static bundle paths (/_next/static, /_next/image) are excluded via
 * the matcher itself so middleware doesn't even boot for them —
 * cheaper than an in-function early return on every asset request.
 */

const PUBLIC_PREFIXES = [
  "/login",
  "/manifest.webmanifest",
  "/sw.js",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
];

function isPublicPath(pathname: string): boolean {
  for (const p of PUBLIC_PREFIXES) {
    if (pathname === p || pathname.startsWith(`${p}/`)) return true;
  }
  return false;
}

/**
 * Cron / automation allow-list. A scheduled caller (GitHub Actions) hits
 * these NAV/index refresh endpoints with no session cookie, so we let it
 * through IFF it presents the shared CRON_SECRET as a bearer token. Scoped
 * to the refresh routes only, and fail-closed: no CRON_SECRET configured
 * (or a mismatch) → no bypass, the request falls through to the normal gate.
 */
const CRON_PATHS = [
  "/api/refresh-mf-nav",
  "/api/refresh-nps-nav",
  "/api/refresh-hdfc-intl-nav",
  "/api/refresh-index-levels",
];

// Length-checked constant-time compare — crypto.timingSafeEqual isn't in the
// Edge runtime, so a wrong secret can't be timed out character-by-character.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function isAuthorizedCron(pathname: string, req: NextRequest): boolean {
  if (!CRON_PATHS.includes(pathname)) return false;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return false;
  return safeEqual(auth.slice("Bearer ".length), secret);
}

/**
 * ── Rate limit on POST /login ────────────────────────────────────────
 *
 * Sliding-window, in-memory counter keyed by client IP. Prevents an
 * attacker who's discovered the deploy URL from brute-forcing
 * APP_PASSWORD by hammering the form.
 *
 * Policy: 5 POSTs per IP per 15 minutes. If you typo three times in
 * a row you're still fine. If someone tries a dictionary attack they
 * get 5 attempts, then a 15-minute cool-off, then 5 more, etc. — an
 * effective ceiling of ~500 attempts per day per IP, which reduces a
 * "10-million-word dictionary" attack from "one afternoon" to
 * "~50 years". Combined with a random 20+ character password, this
 * is enough for a personal deployment.
 *
 * Where the state lives
 * ---------------------
 * Module-level Map. Persists for the lifetime of the Edge isolate
 * (many minutes to hours of warm-state). Cold-start recycles clear
 * the counter, which theoretically gives an attacker "free retries"
 * — but they'd need to time their attacks around Vercel's isolate
 * lifecycle, which is unpredictable and per-region. In practice
 * their effective rate stays at "5 per warm interval per IP", which
 * is still slower than the password's entropy can withstand.
 *
 * If you ever move to Pro and want to survive cold starts, swap the
 * Map for an Upstash Redis call (their free tier is more than enough
 * for a login endpoint). Interface stays identical, just replace the
 * two helper functions.
 *
 * IPv4 vs IPv6
 * ------------
 * Vercel populates x-forwarded-for with the real client IP (they
 * strip attacker-controlled values before their edge). First entry
 * in a comma-separated list is the origin client. We use the raw
 * string as the map key — /64-bucketing IPv6 would be more
 * sophisticated but adds parsing complexity for marginal gain.
 * Attacker rotating IPv6 /64s is theoretically possible but far
 * beyond the threat model for a personal dashboard.
 *
 * No cleanup
 * ----------
 * The Map grows only when new IPs attempt logins. Each entry is
 * ~50-100 bytes. Even a 1000-IP attack fills < 100 kB. The isolate
 * recycles before this becomes a memory concern.
 */

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

const loginAttempts = new Map<string, number[]>();

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? null;
}

/** Returns the count of attempts still within the window, after pruning old entries. */
function pruneAndCountAttempts(ip: string, now: number): number {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const raw = loginAttempts.get(ip);
  if (!raw) return 0;
  const kept = raw.filter((ts) => ts > cutoff);
  if (kept.length === 0) {
    loginAttempts.delete(ip);
    return 0;
  }
  if (kept.length !== raw.length) loginAttempts.set(ip, kept);
  return kept.length;
}

function recordAttempt(ip: string, now: number): void {
  const arr = loginAttempts.get(ip) ?? [];
  arr.push(now);
  loginAttempts.set(ip, arr);
}

function rateLimitLoginPost(req: NextRequest): NextResponse | null {
  const ip = clientIp(req);
  // No IP → don't rate limit. This should only happen in weird test
  // scenarios; on real Vercel every request has an x-forwarded-for.
  // Fail open on the RATE LIMITER doesn't mean fail open on AUTH —
  // the password check still runs unchanged.
  if (!ip) return null;

  const now = Date.now();
  const priorCount = pruneAndCountAttempts(ip, now);

  if (priorCount >= RATE_LIMIT_MAX) {
    // Compute how long until the oldest still-counted attempt ages
    // out of the window — that's when they'll have a free slot again.
    const oldest = loginAttempts.get(ip)?.[0] ?? now;
    const retryMs = Math.max(0, oldest + RATE_LIMIT_WINDOW_MS - now);
    const retryMin = Math.max(1, Math.ceil(retryMs / 60_000));
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    // Preserve `next` from the original URL so the user still lands on
    // the page they were trying to reach after the cool-off. Everything
    // else in the query (including any prior `?error=Invalid password`)
    // gets replaced with just our rate-limit message.
    const preservedNext = url.searchParams.get("next");
    url.search = "";
    if (preservedNext) url.searchParams.set("next", preservedNext);
    url.searchParams.set(
      "error",
      `Too many attempts. Try again in ${retryMin}m.`
    );
    // 303 forces the browser to follow the redirect as a GET rather
    // than replaying the POST — otherwise the form would resubmit
    // on redirect and we'd loop rate-limit-hit → redirect → resubmit
    // → rate-limit-hit forever.
    const res = NextResponse.redirect(url, 303);
    res.headers.set("Retry-After", String(Math.ceil(retryMs / 1000)));
    return res;
  }

  recordAttempt(ip, now);
  return null;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Never mutate request headers for Next internals/static assets.
  // Passing custom request headers via NextResponse.next({ request })
  // is useful for app routes (we forward x-pathname for RootLayout),
  // but it can break static chunk resolution when applied to /_next/*.
  // Hard-bypass those paths so JS/CSS/assets are served by Next's
  // internal static handler unchanged.
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico") {
    return NextResponse.next();
  }

  // Forward the pathname to the app via a request header so the root
  // layout can render conditionally per-route without needing to move
  // every page into a route group. `headers()` in Server Components
  // reads REQUEST headers, so this needs to ride along on the request
  // clone below (not the response).
  const forwardedHeaders = new Headers(req.headers);
  forwardedHeaders.set("x-pathname", pathname);
  const passthrough = () =>
    NextResponse.next({ request: { headers: forwardedHeaders } });

  // Rate limit BEFORE anything else on POST /login. Doing it in
  // middleware rather than the server action means we short-circuit
  // before the action even wakes up — an attacker gets zero server-
  // action cold-start cost, so the endpoint stays cheap for us and
  // painful for them.
  if (pathname === "/login" && req.method === "POST") {
    const blocked = rateLimitLoginPost(req);
    if (blocked) return blocked;
  }

  if (isPublicPath(pathname)) return passthrough();

  // Scheduled NAV/index refreshes (GitHub Actions) authenticate with
  // CRON_SECRET instead of a login cookie — let them through here.
  if (isAuthorizedCron(pathname, req)) return passthrough();

  const secret = process.env.APP_SESSION_SECRET;
  if (!secret) {
    // Fail closed rather than accidentally serving the app un-gated
    // if the env var isn't wired up. Message is deliberately explicit
    // so the fix is obvious the first time you see it. ASCII-only
    // text and a charset=utf-8 Content-Type so no character rendering
    // surprises across browsers / terminals (an earlier version used
    // a Unicode arrow that mojibaked to "â†'" in some clients).
    return new NextResponse(
      "APP_SESSION_SECRET env var is not set.\n\n" +
        "Local dev: add APP_SESSION_SECRET=<random-32-bytes> and " +
        "APP_PASSWORD=<your-password> to .env.local, then restart the dev server.\n\n" +
        "Vercel: set both in Project Settings -> Environment Variables, then redeploy.\n\n" +
        "Generate a session secret with:  openssl rand -base64 32",
      {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }
    );
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const valid = token ? await verifySession(token, secret) : false;

  if (valid) return passthrough();

  // Redirect to /login, preserving the original pathname + query so
  // login can send you back there. We keep query-string-only failures
  // (e.g., a stale bookmarked chart URL) intact by copying nextUrl
  // rather than reconstructing.
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  // Store the intended destination in `next=`. Empty/root paths don't
  // need it — /login already defaults to / on success.
  const original = pathname + (req.nextUrl.search || "");
  if (original !== "/" && original !== "") {
    loginUrl.searchParams.set("next", original);
  }
  return NextResponse.redirect(loginUrl);
}

/**
 * Matcher scope
 * -------------
 * Match every request EXCEPT:
 *   • /_next/static/*  — build-time static chunks; content-hashed, safe
 *   • /_next/image/*   — next/image optimiser; would be pointless to
 *                        auth-check since it just proxies public assets
 *   • /favicon.ico     — belt-and-braces with PUBLIC_PREFIXES above
 *
 * Any /api/* route IS gated by this matcher — server actions, refresh
 * routes, ingest endpoints. That's intentional: an authenticated user
 * still hits them via the same cookie, but a stranger scanning the
 * subdomain can't call /api/refresh-mf-nav to burn our Yahoo/mfapi
 * quotas or trigger DB writes.
 */
export const config = {
  // Keep middleware off Next internals/static assets entirely.
  // (We still have a defensive runtime bypass at the top of middleware.)
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
