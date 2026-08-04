/**
 * Route-level fallback while the next page's server work runs.
 * Paired with NavigationProgress (top bar) so a nav click is never
 * silent — the bar starts immediately; this replaces main content
 * once the App Router commits the transition into a Suspense boundary.
 */
export default function Loading() {
  return (
    <div
      className="pointer-events-none fixed inset-0 z-40 grid place-items-center"
      role="status"
      aria-live="polite"
      aria-label="Loading page"
    >
      <div className="flex flex-col items-center gap-3">
        <div
          className="h-7 w-7 animate-spin rounded-full border-2 border-[hsl(var(--primary)/0.25)] border-t-[hsl(var(--primary))]"
          aria-hidden
        />
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    </div>
  );
}
