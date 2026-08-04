// Vayu service worker — installability shim
// ==========================================================
// The MINIMAL service worker required for Chrome/Edge to treat the
// app as PWA-installable. Deliberately does NOT cache any responses:
//
//   • Vayu's data (portfolio values, NAV history, MF/NPS/EPF totals)
//     is stale after minutes, not hours. A cached HTML page or API
//     response would be actively misleading — you'd see yesterday's
//     numbers thinking they're today's.
//   • The `background_color` in manifest.webmanifest already gives us
//     an instant splash screen while the network responds, which is
//     the main perceived-perf win a naive cache-first SW would offer.
//   • No offline mode. If you're offline, the app fails fast (browser's
//     built-in "no internet" screen) rather than pretending to work
//     with stale data.
//
// If we later add offline reading of the last-known snapshot, this is
// where the runtime caching strategy would live (Workbox-style
// stale-while-revalidate on GET /, cache-first on manifest + icons).
//
// IMPORTANT: keep this file at /sw.js. Moving it (e.g. to a hashed
// build artifact under /_next/) would break the "scope" contract with
// the browser and cause the PWA to uninstall silently.

const SW_VERSION = "vayu-sw-v2";

self.addEventListener("install", (event) => {
  // Take over as soon as we're activated instead of waiting for all
  // open tabs to close first. Nothing here to prefetch so this is the
  // whole install step.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Claim any pages already open on this origin so they use this SW
  // (rather than remaining under the previous version, which would
  // require a page reload to swap).
  event.waitUntil(
    (async () => {
      // Defensive cleanup: this SW intentionally does not cache, but
      // purge any legacy caches from prior experiments to avoid stale
      // app-shell behavior in installed PWA contexts.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  // No-op passthrough. The mere existence of a fetch listener is
  // enough to satisfy Chrome's installability check. All requests
  // go straight to the network as if there were no SW at all.
});

self.addEventListener("message", (event) => {
  // Support the "reload SW" pattern in case we later add a "refresh
  // from server" button in the UI. Ignored for now — no cache to bust.
  if (event.data === "skip-waiting") {
    self.skipWaiting();
  }
});
