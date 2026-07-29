import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { TopNav } from "@/components/nav/TopNav";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";

export const metadata: Metadata = {
  title: "VAYU — Personal Portfolio",
  description: "Personal net worth, holdings and sync operations",
  // ── PWA installability ─────────────────────────────────────
  // manifest.webmanifest is what Chrome/Edge/Safari read to decide
  // whether the site can be "installed" (Add to Home Screen) and
  // what name / icon / splash colours the installed app should
  // use. Serving it via Next's Metadata rather than a raw <link>
  // ensures the tag is emitted in <head> reliably before any
  // client-side hydration.
  manifest: "/manifest.webmanifest",
  applicationName: "Vayu",
  // iOS Safari doesn't respect manifest.webmanifest fully, so we
  // duplicate the essentials via `appleWebApp`. Enables the "Add
  // to Home Screen" → standalone-window behaviour on iPhone, using
  // /apple-touch-icon.png as the launcher icon.
  appleWebApp: {
    capable: true,
    title: "Vayu",
    statusBarStyle: "black-translucent",
  },
  // Suppress iOS auto-linking of numeric strings as phone numbers —
  // Vayu is full of ₹-values that shouldn't render as tappable
  // tel: links.
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

/**
 * Split from `metadata` per Next.js 15's recommendation — theme-color
 * and viewport now live under `viewport` export so they can vary per
 * media query without duplicating the whole metadata object.
 *
 * theme_color drives the Android status bar / iOS Safari address-bar
 * tint when the PWA is installed AND the top browser chrome when
 * visited as a normal website. We pin both light and dark modes to
 * the app's primary indigo so the header of the installed app never
 * looks disconnected from the top of the page.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#5c56d9" },
    { media: "(prefers-color-scheme: dark)", color: "#5c56d9" },
  ],
  width: "device-width",
  initialScale: 1,
  // viewportFit: cover lets the app draw into the notch / dynamic
  // island area on iPhone when installed as PWA. Combined with the
  // black-translucent statusBarStyle above, that means status bar
  // icons stay visible but the app's background bleeds up to the
  // physical edge of the screen — same as native apps.
  viewportFit: "cover",
};

// Runs synchronously in <head> BEFORE first paint. Reads the saved theme
// from localStorage (falling back to OS preference) and stamps
// data-theme on <html> so the correct CSS variables are already resolved
// when the page renders. Without this, the page would flash in the dark
// default and then flip to light after React hydrates — a classic FOUC.
// dangerouslySetInnerHTML is fine here because the string is a constant
// literal, not user-controlled input.
const themeInitScript = `(function(){try{var t=localStorage.getItem('vayu:theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches){document.documentElement.setAttribute('data-theme','light');}}catch(e){}})();`;

// suppressHydrationWarning on <html> is the officially-recommended pattern
// for theme toggles that stamp data-theme via a pre-hydration script.
// Server can't know the user's saved theme (no localStorage on the server)
// so it always emits <html> without data-theme; the client script writes
// the attribute before React hydrates. Without the suppression, React 19
// flags this intentional attribute mismatch as a hydration error.
// The prop only silences warnings for <html>'s own attributes — every
// descendant still gets full hydration checking.
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Read the pathname header injected by middleware.ts so we can hide
  // the TopNav on /login. Skipping TopNav on /login isn't purely
  // cosmetic — TopNav is a Server Component that runs several
  // Supabase queries on every render (holdings freshness + NAV
  // freshness chips). Rendering it for an unauthenticated visitor
  // would waste those queries AND leak sync-status metadata to
  // anyone who lands on the login URL.
  //
  // If the header is missing for any reason (e.g., middleware didn't
  // run because the path was in the static-asset exclusion list),
  // we default to showing TopNav — the static-asset paths don't
  // render layouts anyway, so this is only a defensive fallback.
  const h = await headers();
  const pathname = h.get("x-pathname") ?? "";
  const isStudio =
    pathname === "/studio" || pathname.startsWith("/studio/");
  // Studio joins /login as a "no chrome" surface — for two reinforcing
  // reasons:
  //   1. Recording quality: Studio is the daily video capture surface
  //      for the 10K→100Cr series. A nav bar reading
  //      "VAYU. Studio Overview Portfolio Credits Sync Settings
  //      Filings" across the top of every frame is exactly the kind of
  //      app chrome that pulls the viewer's eye off the growth chart.
  //   2. Mobile layout: on iPhone-class viewports (~414px) TopNav's
  //      seven links + two freshness chips + three action icons blow
  //      past the viewport width, causing horizontal page overflow.
  //      That overflow was previously invisible because <main> was
  //      max-w-6xl mx-auto (implicitly capping observable width), but
  //      the moment /studio went full-bleed the underlying overflow
  //      surfaced as a scrollable right edge. Hiding TopNav on
  //      /studio removes the overflow trigger entirely for the one
  //      route that actually needs a mobile-first layout.
  //
  // Access on /studio: the PWA launcher icon deep-links here, and
  // during dev you type /studio in the URL. Browser/gesture back
  // still works to return to whatever route you came from. A
  // dedicated back-to-home affordance inside Studio is deferred
  // until we've lived with the current flow for a few recordings.
  const hideChrome = pathname === "/login" || isStudio;
  const fullBleed = isStudio;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans antialiased">
        {hideChrome ? null : <TopNav />}
        <main
          className={
            fullBleed
              ? "w-full"
              : "mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10"
          }
        >
          {children}
        </main>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
