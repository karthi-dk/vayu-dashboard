# Changelog

All notable changes to **Vayu / FolioPulse** are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [SemVer](https://semver.org/) for app releases (`package.json`
`version`). Each production deploy from `main` should correspond to an entry
here (or an amendment under `[Unreleased]` that is cut into a dated version
at push time).

## [Unreleased]

### Added

- **EPF · Growth breakdown** — multi-year EPF chart (contributions vs
  interest, Feb 2019 → now) reconstructed from EPFO passbooks; the
  wealth-composition EPF and net-worth buckets are now passbook-accurate
  (no longer flagged "estimated").
- **Multi-year Net Worth** — Net Worth Trend and Composition charts now
  extend from inception (₹0) using reconstructed MF / NPS / EPF history,
  with exact deposits-vs-growth attribution on every window.

### Fixed

- **Index "Today" move** — when Yahoo drops a session's daily bar (null
  OHLC — it did for the NSE indices on 2026-08-03), recover that
  session's close from the intraday feed instead of silently falling
  back to an earlier day. Previously "Today" could span multiple
  sessions and even show the wrong sign (up when actually down).
- **Index 3M / 52W / ATH columns** — feed the recovered close into the
  peak calc too, so a dropped record session no longer makes an index
  wrongly read 0.0% ("at its high") when it is actually below it.
- Raise hamburger breakpoint from `md` (768px) to `lg` (1024px) — at
  tablet widths the full inline nav still clipped Settings and pushed
  ThemeToggle / Sign out off-screen.
- Navigation progress bar: keep visible until the clicked route lands
  (URL can update before paint with `loading.tsx`), show immediately,
  sit below iPhone safe-area + TopNav so it isn’t hidden under the
  notch/status bar.
- Mobile nav: drive hamburger vs desktop links with `matchMedia`
  (1024px) instead of Tailwind `md:flex`/`lg:flex` alone — production
  CSS had purged those utilities, so iPhone XR kept showing the full
  overflowing link row with no menu button.

### Planned

- Flip `SHOW_STUDIO_REPLAY` off in `RevealDashboard.tsx` when recording /
  choreography tuning is done.

---

## [0.2.0] — 2026-07-29

Production: **https://foliopulse.vercel.app** (Vercel project / GitHub
`karthi-dk/vayu-dashboard`, push to `main`).

### Added

- **Mobile hamburger nav** — below `md`, TopNav collapses to brand +
  freshness + refresh + menu. Sheet (portaled to `document.body`) lists
  Studio themes, app routes, theme toggle, and sign out.
- **Navigation progress** — thin top progress bar on internal link
  clicks; `app/loading.tsx` route fallback spinner.
- **Sync → Delete all test data** — purges `mf_transactions` rows with
  `platform=test` (`deleteStudioTestData` server action).
- **Studio Replay on production** — temporary `SHOW_STUDIO_REPLAY`
  flag so reveal choreography can be re-fired without Back → Submit
  (remove after recording).
- **`cross-env`** for Windows-safe `npm run dev` / `npm start`
  (`NODE_TLS_REJECT_UNAUTHORIZED=0`).
- This **CHANGELOG.md** as the release log for commits / builds.

### Changed

- **CelebrationOverlay** — portals to `document.body`, locks scroll,
  sizes the Lottie square explicitly, waits for layout before play
  (fixes intermittent right-shifted confetti that snapped to center
  mid-burst).
- **Studio reveal audio** — rollup path / timing polish in
  `lib/studio/sounds.ts` + `RevealDashboard` (single ending jackpot;
  no extra follow-up ding).
- **SignOutButton** — marked `"use client"` so MobileNav can import it
  without breaking the RSC boundary.

### Removed

- **Studio TEST MODE banner** — yellow header strip removed from all
  studio themes. Test writes still use `platform=test` when
  `NEXT_PUBLIC_FUNDS_TEST_MODE=true`; purge via Sync.

### Fixed

- Mobile menu sheet clipped to header height (TopNav `backdrop-blur`
  containing block) — fixed by body portal + full `100dvh` panel.
- Webpack / SSR `Cannot read properties of undefined (reading 'call')`
  from client → server SignOutButton import.

### Docs

- README, DEPLOY.md, and HANDOVER.md updated for this release.
- Shared nav link list lives in `components/nav/navConfig.ts`.

---

## [0.1.0] — 2026-07

Initial production baseline on Vercel (Next 15.3.x, auth gate, PWA,
Studio themes deep links, MF weak-key dedup ignoring `platform=test`).

See git history from `e0c72a1` through `6b2f691` for the pre-changelog
commit trail.

---

[Unreleased]: https://github.com/karthi-dk/vayu-dashboard/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/karthi-dk/vayu-dashboard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/karthi-dk/vayu-dashboard/releases/tag/v0.1.0
