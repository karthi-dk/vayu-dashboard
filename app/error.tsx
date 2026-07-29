"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const isTls =
    error.message.includes("SELF_SIGNED_CERT") ||
    error.message.includes("fetch failed");

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-lg font-semibold text-foreground">
        Could not load dashboard data
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {isTls ? (
          <>
            Supabase fetch failed — often caused by a corporate SSL proxy on
            local dev. Run{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              npm run dev
            </code>{" "}
            (it sets <code className="font-mono text-xs">NODE_TLS_REJECT_UNAUTHORIZED=0</code>{" "}
            for local only). On Vercel this does not apply.
          </>
        ) : (
          error.message
        )}
      </p>
      <button
        onClick={reset}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Retry
      </button>
    </div>
  );
}
