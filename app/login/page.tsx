import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { login } from "./actions";

/**
 * /login — the single unprotected route.
 *
 * If you're ALREADY logged in and stumble onto /login (e.g., typed the
 * URL manually or clicked a stale bookmark), we short-circuit straight
 * to /. No point showing a password form to someone whose cookie is
 * valid — that would be confusing UX and just an extra page load.
 *
 * On a fresh visit (no cookie / expired cookie), render the form and
 * let app/login/actions.ts handle the submit. `?error=...` from a
 * failed prior attempt is rendered inline.
 */

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;

  const secret = process.env.APP_SESSION_SECRET;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (secret && token && (await verifySession(token, secret))) {
    // Already authenticated — bounce to the requested destination
    // (or / by default). We DON'T re-validate `next` here because
    // login/actions.ts already did that; anything unsafe would have
    // been rewritten to "/" before landing back on us.
    redirect(params.next && params.next.startsWith("/") ? params.next : "/");
  }

  const nextPath = params.next ?? "";
  const err = params.error ?? "";

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="w-full">
        <h1 className="text-center text-xl font-semibold text-foreground">
          Vayu
        </h1>
        <p className="mt-1 text-center text-xs text-muted-foreground">
          Enter your password to access the dashboard
        </p>
      </div>
      <form
        action={login}
        className="flex w-full flex-col gap-3 rounded-xl border border-border bg-background/60 p-5 shadow-sm"
      >
        {/* `next` is passed through as a hidden field so the server
            action knows where to redirect after a successful login.
            Middleware sets this from the original URL you tried to
            visit before being bounced here. */}
        <input type="hidden" name="next" value={nextPath} />
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Username
          </span>
          {/* autoComplete="username" is what tells password managers
              "this is the identity field for the credential" — pairs
              with the current-password field below so Chrome / 1Password
              / Safari Keychain save the pair correctly as a single
              credential rather than two orphan autofills.
              inputMode="text" (default) + no auto-capitalise: the
              username should be typed exactly, no first-letter caps
              from mobile keyboards. */}
          <input
            name="username"
            type="text"
            required
            autoFocus
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[hsl(var(--primary))] focus:ring-2 focus:ring-[hsl(var(--primary)/0.25)]"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Password
          </span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-[hsl(var(--primary))] focus:ring-2 focus:ring-[hsl(var(--primary)/0.25)]"
          />
        </label>
        {err ? (
          <p
            className="rounded-md border border-[hsl(var(--danger)/0.35)] bg-[hsl(var(--danger)/0.08)] px-3 py-2 text-xs text-[hsl(var(--danger))]"
            role="alert"
          >
            {err}
          </p>
        ) : null}
        <button
          type="submit"
          className="mt-1 rounded-md bg-[hsl(var(--primary))] px-3 py-2 text-sm font-medium text-[hsl(var(--primary-foreground))] transition hover:opacity-90"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
