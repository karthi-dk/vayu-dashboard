import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client
 * ===========================
 *
 * This module is protected by `import "server-only"` — if any client
 * component ("use client") tries to import from here, Next.js will
 * throw a build error. That's the primary defence: DB credentials
 * physically cannot land in the browser bundle.
 *
 * Why service_role, not anon
 * --------------------------
 * With RLS enabled and no `SELECT` / `INSERT` policies, the anon key
 * gets denied on every table. This dashboard has no auth layer
 * (single-user, personal use), so writing per-user RLS policies would
 * be theatre. Instead we:
 *   1. Enable RLS with zero policies → deny-all for anon
 *   2. Use service_role from server code → bypasses RLS
 *   3. Never send Supabase credentials to the browser
 *   4. Every browser → DB path goes through Next.js API routes
 *      (which run server-side and use this client)
 *
 * That closes the "public anon key + no RLS = anyone can read/write
 * everything" hole the project shipped with.
 *
 * Env vars
 * --------
 *   NEXT_PUBLIC_SUPABASE_URL   — the project URL. Still `NEXT_PUBLIC_`
 *                                because some tooling / future browser
 *                                utilities may need it; the URL alone
 *                                is not a credential.
 *   SUPABASE_SERVICE_KEY       — the service_role secret. NO
 *                                `NEXT_PUBLIC_` prefix → Next.js will
 *                                refuse to bundle it into any client
 *                                chunk. Fail-fast if missing.
 *
 * Both are required. There is deliberately no anon fallback here —
 * a silent fallback would mask a misconfigured deployment and let
 * every DB query fail one at a time under RLS instead of failing
 * loudly at import time.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!url) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL. Copy .env.example to .env.local and set it."
  );
}
if (!serviceKey) {
  throw new Error(
    "Missing SUPABASE_SERVICE_KEY. This is the service_role secret from " +
      "Supabase Dashboard → Settings → API. Do NOT prefix with NEXT_PUBLIC_ " +
      "— that would leak the key to browsers."
  );
}

/**
 * The one and only Supabase client in this project. Import this from
 * any server code (Route Handlers, Server Actions, Server Components,
 * server-only libs like lib/queries.ts).
 *
 * Named `sbServer` to make it visually obvious at the call site that
 * this must not be dragged into a client component. The `server-only`
 * import at the top of this file will catch any accidental attempt at
 * build time, so this is belt + braces.
 */
export const sbServer = createClient(url, serviceKey, {
  auth: { persistSession: false },
});
