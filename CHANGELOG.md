# Changelog

All notable changes to **Vayu / FolioPulse** are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [SemVer](https://semver.org/) for app releases (`package.json`
`version`). Each production deploy from `main` should correspond to an entry
here (or an amendment under `[Unreleased]` that is cut into a dated version
at push time).

## [Unreleased]

### Planned

- Flip `SHOW_STUDIO_REPLAY` off in `RevealDashboard.tsx` when recording /
  choreography tuning is done.

## [0.3.1] — 2026-09-08

### Added

- **Automated NAV refresh (GitHub Actions)** — MF / NPS / International
  NAVs now refresh every 3 hours and index levels hourly during market
  hours (9am–4pm IST, Mon–Fri), via two scheduled workflows that call the
  refresh routes with a `CRON_SECRET` bearer token. `middleware.ts`
  allow-lists that token for the refresh routes only (fail-closed if the
  secret is unset). Removes the reliance on opening the app to update NAVs.

### Fixed

- **1D change no longer double-counts a stalled fund** — the Overview MF
  card, the Portfolio headline, and the persisted `nw_daily` 1D now sum
  only funds priced at the headline NAV date, over that same fresh base.
  A fund still pending its NAV (e.g. PPFAS mid-morning) can no longer
  inject a frozen prior-day delta or dilute the %, so the card, the
  “(N stale)” pill, and the Total-NW headline reconcile.
- **International 1D stops repeating a frozen value** — when the freshest
  overseas NAV is several days old the card shows “— 1D · {date} (stale)”
  instead of carrying the last move forward indefinitely; the stored
  `intl_1d_change_inr` is cleared to match.

## [0.3.0] — 2026-09-03

### Added

- **International — a new top-level asset class** — your overseas equity
  (the ICICI Nasdaq FoF, moved out of MF, plus the new **HDFC GIFT City /
  IFSC USD fund**) is now first-class alongside MF, NPS and EPF: its own
  stat card, growth-breakdown chart, headline figure, allocation-donut
  slice and period-returns grid, with history reconstructed back to
  Feb 2019. USD funds mark to NAV × **live USD→INR**; the “exit today”
  (short-term redemption) value is shown separately.
- **Foreign look-through** (Portfolio) — your real per-company overseas
  exposure, merged across ICICI, HDFC DM **and domestic funds’ US slices**
  (e.g. PPFAS’s Alphabet/Meta), so it reads as “my Apple exposure”, not
  one row per fund.
- **Country composition** (Portfolio) — where your foreign money sits by
  country; click any country to drill into its holdings.
- **Foreign sector exposure** (Portfolio) — the GICS sector mix of the
  foreign book (as % of foreign), directly under the NSE sector card;
  click any sector to see the companies inside. Any future foreign fund
  flows in automatically.
- **International NAV refresh** — a dedicated card on the Sync page, and
  folded into the TopNav “Refresh all” (now MF · NPS · International ·
  Index highs).
- **International fund · NAV‑vs‑FX growth chart** — a per‑fund chart
  (Overview) that splits your INR return into the fund’s USD NAV vs the
  USD→INR move as a stacked contribution (Fund + FX = Total). Marked at the
  fund’s **Purchase NAV** (matches your cost basis; “exit today” uses the
  short‑term redemption NAV). Backed by a new daily **FX rate
  store** (`fx_rates`) so its rates match the card’s source (open.er‑api),
  with Yahoo `USDINR=X` as a bootstrap fallback for days before the store.
- **Net-worth “period returns” grid** — under the headline value, a compact
  multi-window strip (1M → ALL) splitting each window's change into what you
  **added** (deposits) vs **market growth**, plus a not-annualised return %
  (growth ÷ capital deployed). Replaces the earlier single-figure chips.
- **MF · period returns** — the same deposits-vs-growth grid scoped to mutual
  funds, below the MF Growth Breakdown; shows as many windows as the MF
  history supports (longer ones appear automatically as it ages).
- **Stat cards · absolute gain** — MF / NPS / EPF cards now show the ₹ gain
  beside the % (e.g. `+5.00% (+₹1.98 L) vs net deposits ₹39.75 L`); EPF adds a
  contributed-vs-interest line (`+18.3% (+₹2.97 L) vs contributed`).
- **Stat cards · NAV date on the 1D chip** — the 1D chip shows the NAV's
  “as of” day (e.g. `1D · 18 Aug`), with an `(N stale)` hint when FoF /
  international funds lag the batch headline.
- **TopNav NAV freshness** — the NAVs chip now flags absolute staleness (an
  amber “NAV is N days old” note when the batch trails today) and shows when a
  refresh was served by the **mfapi fallback** instead of AMFI (from the
  persisted `nav_source`), so a silent source outage is visible at a glance.
- **EPF · Growth breakdown** — multi-year EPF chart (contributions vs
  interest, Feb 2019 → now) reconstructed from EPFO passbooks; the
  wealth-composition EPF and net-worth buckets are now passbook-accurate
  (no longer flagged "estimated").
- **Multi-year Net Worth** — Net Worth Trend and Composition charts now
  extend from inception (₹0) using reconstructed MF / NPS / EPF history,
  with exact deposits-vs-growth attribution on every window.
- **NPS · Scheme breakdown** — Equity / Corporate / Govt (E·C·G) shown as
  text inside the NPS Growth card: % of corpus, amount invested, current
  value, and a per-scheme XIRR (counts inter-scheme switches), plus a
  totals row.
- **EPF XIRR** — money-weighted return badge on the EPF Growth breakdown
  card (≥1-year guard; the annual interest-crediting caveat is in the
  tooltip).
- **Portfolio cap split — Nifty 50 vs Next 50** — the Indian-equity cap
  donut splits the old “Large” slice into Nifty 50 and Nifty Next 50 via
  NSE index membership (now reads N50 · NN50 · Mid · Small).
- **Index highs — refresh icon** — a dedicated refresh button on the Index
  highs card pulls fresh levels and updates in place (soft refresh, no
  full page reload).

### Changed

- **Sector exposure is now Indian-equity-only** — the NSE-classified tiled
  card (and its click-to-drill modal) excludes the International asset
  class **and** domestic funds’ foreign slices, so it’s a clean
  Indian-equity view and every tile reconciles exactly with its
  drill-down. All foreign equity lives in the Foreign look-through /
  Country / Foreign-sector cards instead.
- **ICICI Nasdaq reclassified** from MF to International — across today’s
  values and the full net-worth history (total net worth unchanged; the
  split is reconstructed from the transaction ledger day-by-day).
- **Stat-card order** is now MF → EPF → International → NPS.
- **HDFC international fund** shows the “Direct” plan label (was “Class A”).

### Fixed
- **International “stale” flag is now lag-aware** — HDFC DM feeds a UCITS ETF
  and publishes ~T+2, so it structurally trails ICICI’s same-day NAV; the card
  no longer flags that normal lag as “(N stale)”. Only a genuine multi-day
  publish outage trips it now.
- **HDFC DM now counts from its 27 Aug allotment** in net-worth history — it
  previously only appeared from its 2 Sep seed, causing a one-day ~₹4.8 L jump;
  backfilled so it shows as a deposit on the allotment date and the net-worth
  line stays continuous.
- **AMFI NAV parser — format drift (MF NAVs silently a day stale)** — AMFI's
  `NAVAll.txt` changed from 6 to 8 `;`-separated columns; the parser required
  exactly 6, so it parsed **0 rows** and silently fell back to the day-lagging
  mfapi.in — leaving every MF NAV (and its 1D) a day behind with no visible
  signal. Now indexes NAV/date from the **end** of the row, handling both the
  6- and 8-column layouts.
- **NPS `nav_date` off-by-one** — Kotak's early-morning `ENTRY_DATE` stamps a
  freshly-fetched NAV with *today* even though the value is the previous
  trading day's (NPS declares in the evening). The refresh now rolls a
  today-stamped NAV back to the prior trading day when fetched before the
  evening window, so the NPS “as of” date matches the true valuation day
  (as AMFI already does for MF).
- **Stat-card polish** — the 1D `(−0.33%)` now takes the same green/red sign
  colour as the ₹ figure; the EPF gain tooltip anchors to its left edge so it
  no longer clips off the card.- **Index "Today" move** — when Yahoo drops a session's daily bar (null
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
- **`PGRST303` “JWT issued at future” resilience** — widened the transient-
  retry backoff (~5.5s → ~18.5s) and wrapped the Sync page's un-guarded
  count query, so the post-idle Supabase clock-skew self-heals instead of
  surfacing “Could not load dashboard data”. Root cause removed by moving
  `SUPABASE_SERVICE_KEY` to the legacy `service_role` JWT (fixed `iat`).
- **MF card no longer double-counts International** — fund count, the 1D
  chip’s `(N stale)` hint, the equity/debt split and the net-deposits base
  are all MF-only now; the NAV-staleness flag moved to the International
  card (HDFC lags ICICI by a day).
- **International missing from net-worth rollups** — the reconstructed
  Net-Worth trend/composition, Equity-Debt, Liquidity, Wealth-composition
  cards and the headline 1D now all include the International slice (it was
  dropped when the asset class was first split out of MF).
- **Historical International split** — reclassifying ICICI across past
  net-worth days now reconstructs units-at-that-date from the SIP
  transaction ledger (not a current-units snapshot), so the reconstructed
  and observed history join seamlessly with no step.
- **TimeAgo hydration crash** — the relative-time label rendered a
  server/client mismatch on mount; suppressed and ticked after hydration.

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

[Unreleased]: https://github.com/karthi-dk/vayu-dashboard/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/karthi-dk/vayu-dashboard/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/karthi-dk/vayu-dashboard/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/karthi-dk/vayu-dashboard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/karthi-dk/vayu-dashboard/releases/tag/v0.1.0
