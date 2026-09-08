# Handover — current context for the next agent

**Latest app release:** `0.3.1` (2026-09-08) — see **[CHANGELOG.md](./CHANGELOG.md)**  
**Production:** https://foliopulse.vercel.app · **Vercel project:** https://vercel.com/kdeekay/foliopulse  
**Ship path:** push `main` → Vercel production (Git integration)

---

## TL;DR — 0.3.0 (Overview data accuracy)

Since 0.2.0, three data-accuracy features landed on the Overview page.
All reconciled against source; **no DB migration** (the one-time
`epf_state` split correction + corrected `index_levels` rows were written
to the shared Supabase, already live). Build is green; `CHANGELOG.md`
`[Unreleased]` is updated but **not yet cut to a version**.

1. **EPF · Growth breakdown** (contributions vs interest, multi-year).
   - Generator: `scripts/gen-epf-history.py` (pypdf; reads the EPFO
     passbook PDFs in `~/Documents/EPFO PASSBOOK`) → emits committed
     static `lib/epf/epfHistory.generated.ts` (95 monthly points,
     pension/EPS excluded). Has built-in reconciliation asserts and
     aborts on any mismatch. **Re-run it when new passbooks arrive.**
   - `lib/epf/epfHistory.ts` → `buildEpfHistory()` + `EPF_TOTALS`.
     Chart: `components/overview/EpfGrowthBreakdown.tsx`.
   - Reconciled totals: contributions ₹16,25,975 + interest ₹2,96,970
     = value ₹19,22,945 (lifetime return 18.26%).
2. **Multi-year Net Worth** — `lib/nwReconstruct.ts` forward-fills the
   union of MF/NPS/EPF history from an inception ₹0 point;
   `computeNwAttribution(window)` is exact by construction
   (deposits = Δcumulative-contribution, growth = Δvalue − deposits).
   Replaced ledger-based `lib/nwAttribution.ts` (**deleted**;
   `NwAttribution` type moved into `nwReconstruct.ts`). `NWTrendChart`
   and `NWCompositionChart` now take `history={nwHistory}` from
   `getOverviewData`.
3. **Index highs null-gap fix** — `lib/indexLevels/yahooClient.ts`.
   Yahoo intermittently drops a real trading session as a null-OHLC
   daily bar (did so for the NSE indices on 2026-08-03). The code now
   recovers that session's close from the intraday feed
   (`range=5d&interval=1h`) and feeds it into BOTH the "Today %" and the
   ATH/52W/3M peak columns — previously "Today" could span multiple
   sessions (even wrong sign) and a dropped record day made an index
   read 0.0% ("at its high") when it was actually below.4. **NAV source hardening (MF + NPS)** — two *silent* data-staleness bugs
   found + fixed (both matter operationally):
   - **AMFI `NAVAll.txt` parser** (`lib/mf/amfiClient.ts`) — AMFI moved from
     6 to 8 `;`-columns; the parser required exactly 6 → parsed **0 rows**
     → silently fell back to day-lagging mfapi.in, leaving every MF NAV (and
     1D) a day stale with no visible signal. Now reads NAV/date from the
     **end** of the row (handles both layouts).
   - **NPS `nav_date`** (`app/api/refresh-nps-nav/route.ts` +
     `lib/istDate.ts` `previousBusinessDay`) — Kotak's morning `ENTRY_DATE`
     stamps a fresh NAV with *today* though it's the prior trading day's;
     the route now rolls a today-stamped NAV back to the previous business
     day when fetched before the ~8pm IST evening declaration. One-time data
     correction (`nps_state` + `nps_nav_history` 28-Aug→27-Aug) written to
     the shared DB.
   - **Visibility** (`components/nav/TopNav.tsx`) — the NAVs freshness chip
     now flags absolute age (amber when the batch trails today) and a
     `nav_source='mfapi'` fallback, so a future AMFI outage isn't silent.
5. **Period-returns grids** — `NwDeltasCards` (net-worth) + `MfDeltasCard`
   (MF-only, below MF Growth Breakdown), both driven by `computeNwDeltas`
   over `nwHistory` / `mfHistory`. `mfDeltas` added to `getOverviewData`.
   MF shows fewer windows until its history ages past 1Y/3Y/5Y.
6. **Stat-card gains** — MF/NPS/EPF cards show the ₹ gain beside the %; EPF
   gained a contributed-vs-interest line; the 1D chip shows the NAV “as of”
   date + `(N stale)`.
**Local diagnostics gotchas:** Node scripts hitting Supabase need the
`NODE_TLS_REJECT_UNAUTHORIZED=0` prefix (corporate self-signed proxy).
`tsx` is NOT installed and `npx tsx` tries to install over that proxy —
verify pure-TS logic with a self-contained plain-`node` `.mjs` copy
instead. See `/memories/repo/build-notes.md` for the full play-by-play.

---

## TL;DR — 0.3.0 (International asset class + foreign look-through)

Landed 2026-09-02 (all local; push from the Windows clone). A new
top-level **International** asset class + a foreign look-through suite on
Portfolio. **Requires DB migrations + a backfill (see below).** Build
green (17/17).

- **Model:** a single `asset_class` column (`'mf' | 'intl'`) on
  `fund_holdings` — not a separate table; everything groups by it. ICICI
  Nasdaq flipped to `intl`; the new **HDFC GIFT City DM USD fund** seeded
  as `intl`. `recomputeNwDaily` splits mf vs intl, so `nw_daily.mf_value`
  now **excludes** intl and `total_nw = mf + nps + epf + intl`.
- **USER MUST RUN (shared prod DB):** apply
  `migrations/2026-09-02-international-asset-class.sql`,
  `migrations/2026-09-02-master-country-region.sql`, and
  `migrations/2026-09-02-fx-rates.sql`, then after a NAV
  refresh run `scripts/backfill-intl-reclassification.mjs` (dry-run,
  then `--apply`) to reclassify ICICI in historical `nw_daily`. The
  backfill reconstructs ICICI **units-at-date from the transaction
  ledger** (SIP units change over time) and is idempotent.
- **HDFC intl NAV:** `lib/mf/hdfcIntlClient.ts` (reverse-engineered GIFT
  City API — its `plan_type` param carries the *class*; “Class A” = the
  Direct plan), `lib/fx.ts` (live + historical USD→INR),
  `app/api/refresh-hdfc-intl-nav/route.ts` (marks at gross redemption
  NAV × live FX; “exit today” from the short-term redemption NAV).
- **Per-fund NAV-vs-FX chart** (`components/overview/IntlFundGrowthChart.tsx`
  + `app/api/intl-nav-series/route.ts`): stacked contribution area where
  Fund (USD NAV) + FX bands sum to the Total INR return, for the HDFC USD
  fund. FX comes from the new **`fx_rates` store** (`lib/fxStore.ts`, table
  from `2026-09-02-fx-rates.sql`) — each intl refresh persists that day's
  open.er-api rate so the chart matches the card's source; Yahoo `USDINR=X`
  is a fallback only for dates predating the store (open.er-api has no
  history endpoint). Both degrade gracefully if `fx_rates` isn't migrated.
- **HDFC DM look-through:** its underlying (iShares Core MSCI World,
  ~1,251 names) is ingested via a **paste card** on Sync
  (`app/api/ingest-intl-holdings`, `lib/intl/isharesHoldings.ts`) — the
  iShares holdings API is Akamai bot-gated, so it’s pasted from a live
  browser session. Added `country` + widened the `region` CHECK on
  `master_security_classification`.
- **Foreign look-through suite (Portfolio):** Foreign look-through card,
  Country composition, and **Foreign sector exposure** (GICS, % of
  foreign) — all fed by `foreignLookthrough` in `getPortfolioData` (every
  holding tagged region US/International, merged by company).
- **Sector exposure is now Indian-equity-only:** the NSE card AND its
  drill-down exclude the intl asset class + domestic funds’ foreign
  slices (`isForeignMaster`); the tile now reconciles exactly with its
  drill-down (they are **two separate aggregations** — keep both in sync).
- **Watch out:** the `intl` split has MANY downstream consumers — every
  `mf_value / nps_value / epf_estimate` rollup, every `{mf,nps,epf}`
  slice UI, and `buildNwHistory`. Full play-by-play in
  `/memories/repo/build-notes.md`.
- **2026-09-03 follow-ups:** the USD mark + per-fund chart now use the
  **Purchase NAV** (matches cost basis; “exit today” = short-term redemption);
  `scripts/backfill-hdfc-nw.mjs` folded HDFC into `nw_daily` from its 27 Aug
  allotment (already applied — prod = local shared DB); and the International
  “stale” flag is now lag-aware, so HDFC's ~T+2 UCITS lag no longer false-alarms.

---

## TL;DR — release 0.2.0 (nav / studio UX)

1. **Mobile hamburger** (`components/nav/MobileNav.tsx`) — sheet is
   **portaled to `document.body`**. Do not nest `position:fixed` menus
   under TopNav (`backdrop-blur` / overflow create a containing block
   and clip the sheet to ~56px — that bug already shipped once).
2. **Nav progress** — `NavigationProgress` + `app/loading.tsx`.
3. **Studio confetti** — `CelebrationOverlay` portals + layout-stable
   square sizing; wait for box measure before Lottie autoplay.
4. **TEST MODE banner removed** — test rows still use `platform=test`;
   purge via Sync → `DeleteStudioTestDataCard` /
   `deleteStudioTestData`.
5. **Replay on prod** — `SHOW_STUDIO_REPLAY = true` in
   `RevealDashboard.tsx` (temporary). Flip to `false` after recording.
6. **SignOutButton** is `"use client"` (required for MobileNav). Shared
   routes live in `components/nav/navConfig.ts`.
7. Windows local: `cross-env` in `package.json` `dev` / `start`.

### Release process (keep this)

1. Accumulate notes under `[Unreleased]` in `CHANGELOG.md`.
2. On ship: cut `[x.y.z] — YYYY-MM-DD`, bump `package.json` `version`,
   commit, `git push origin main`.
3. Optionally tag: `git tag v0.2.0 && git push origin v0.2.0`.
4. Reopen installed PWAs after deploy (SW does not cache pages).

---

# Handover — Studio verdict system + sound variants

**Landed:** 2026-07-29  
**Scope:** `/studio` verdict promotion (V1 → 4-tier taxonomy), verdict
sound-variant framework, two pre-existing build blockers fixed.  
**Note:** The section below remains the deep dive for Studio audio /
verdict. For product UX / nav / deploy changes after that work, prefer
**CHANGELOG.md** and the TL;DR above.

---

## TL;DR for the next agent (verdict / sounds)

1. `/studio` is now on a **4-tier verdict system** (`big-green` |
   `green` | `flat` | `red`). The old 5-tier V2 preview is deleted;
   what used to live in `VerdictReactiveV2.tsx` was promoted into
   `VerdictReactive.tsx` and V2 files were removed.
2. `/studio/sounds` gained **two new sections**: "Verdict — Green" and
   "Verdict — Red", each with 18 selectable variants. Defaults are
   `major_bell` (green) and `minor_descent` (red).
3. `next build` passes clean across all 24 routes. Two pre-existing
   errors (Lottie `speed` prop, `canvas-confetti` default import) were
   fixed as part of the handover.
4. No pending TODOs from the verdict task. See "Suggested follow-ups"
   below for optional polish. For **0.2.0** follow-ups (Replay flag,
   etc.) see CHANGELOG `[Unreleased]`.

---

## Design decisions preserved

### Why 4 tiers, not 5

An earlier design had `big-red` as a separate tier from `red`. After
three rounds of calibration on `/studio/verdict`, every small-loss
iteration got pushed toward the big-loss iteration — the tile felt
under-reactive at any point where the tiers were distinct, and the
"which loss is big enough for heavy treatment?" question kept
oscillating. Consolidating fixed the calibration problem: **every
loss now gets the same heavy-dense reaction regardless of magnitude**.
Losses shouldn't escalate the way wins do (users interact with this
tile daily and shouldn't feel punished on bigger drawdowns).

Wins are different: a +1% day genuinely deserves a bigger celebration
than a +0.1% day, so `big-green` (dense triple-bounce, dual-ring halo,
12 sparkles, extended chime) and `green` (double-bounce, single-ring
halo, 8 sparkles, compact chime) remain distinct.

### One selection per side (not per tier)

For green, the user picks ONE variant style — both the small-win and
big-win synths of that variant fire on their respective tiers. The
sound lab exposes both green synths via **dual Play buttons** per row
(`Small` + `Big`) so the user can audition how a style scales before
selecting. Red only has one tier, so red variants have one Play
button.

### Non-punitive red palette

Markets are red ~40% of trading days. Every red variant was authored
to be warm, quiet, and short — nothing that could train a daily
flinch. If a red variant ever feels sharp in production use, tune its
`master` gain constant at the top of its synth function (typical
range 0.09–0.15).

---

## File map — start here

Ordered by "most likely to touch when tuning verdict":

| File | Role |
|------|------|
| `lib/studio/sounds.ts` | 4760 lines. Verdict section starts ~line 2590 (`// ── VERDICT`). Contains: `VerdictTier` type, `resolveVerdictTier`, all 54 verdict synths, `VERDICT_GREEN_VARIANTS` + `VERDICT_RED_VARIANTS` registries, preview functions, `playVerdict` router. |
| `components/studio/VerdictReactive.tsx` | Visual reaction component. Tier keyframes in the `resolveTierConfig` switch. Full docstring at the top explains the halo shapes and the pre-recoil wince. |
| `components/studio/StatsRow.tsx` | Wraps the 1 DAY tile with `VerdictReactive` in production. Also contains the 6-tile grid docstring. |
| `components/studio/RevealDashboard.tsx` | Choreographer. `STUDIO_TIMING.VERDICT_BEGIN = 5500ms` — this is the one dial to move if the verdict feels early/late relative to the rollup ding decay. |
| `app/studio/verdict/page.tsx` | Preview page for the 4 tiers. Fires each on demand and cycles them with 2.5s gaps. |
| `app/studio/sounds/page.tsx` | Sound-variant picker UI. Two new sections at the bottom for green + red verdict. |

The verdict system is fully isolated inside `lib/studio/sounds.ts` and
`components/studio/*`. Nothing outside those two directories reads
`VerdictTier` or calls `playVerdict`.

---

## Current defaults

Set at the top of `lib/studio/sounds.ts`:

```ts
const DEFAULT_VERDICT_GREEN_VARIANT: VerdictGreenVariantId = "major_bell";
const DEFAULT_VERDICT_RED_VARIANT: VerdictRedVariantId = "minor_descent";
```

Fresh installs and cleared localStorage land on these. Existing
selections in localStorage are untouched. Both defaults mirror the
sound that shipped with the earlier 5-tier verdict, so users
upgrading from the previous verdict system hear the same audio.

---

## How to test end-to-end

1. `npm run dev` → `http://localhost:5000/studio/sounds`.
   - Scroll to **Verdict — Green**: each row has **Small** + **Big**
     Play buttons. **Set active** persists to
     `localStorage['studio.verdictGreenVariant']` and dispatches
     `studio:verdict-green-variant-changed`.
   - **Verdict — Red** uses the standard single-Play `VariantRow`
     component. Same persist/broadcast pattern under
     `studio.verdictRedVariant` +
     `studio:verdict-red-variant-changed`.
2. `/studio/verdict` — click each tier's Play button to fire the
   visual + audio reaction on demand. "Play all" cycles the four
   tiers with 2.5s gaps between them. Selections made on
   `/studio/sounds` flow through here immediately (both pages route
   through the same `playVerdict` function).
3. `/studio` — enter and submit a mock order. At t≈5500ms the 1 DAY
   tile plays the tier that matches the mock data's 1D move.

---

## Adding a new verdict variant (recipe)

Green example — same pattern for red, minus the "Big" synth:

1. Add the ID to the `VerdictGreenVariantId` union:
   ```ts
   export type VerdictGreenVariantId =
     | "major_bell"
     | "music_box"
     | ...
     | "my_new_style";
   ```
2. Author two synth functions in the verdict-variants block:
   ```ts
   function synthMyNewStyleGreen(ctx: AudioContext): void { ... }
   function synthMyNewStyleBigGreen(ctx: AudioContext): void { ... }
   ```
   Keep `master` gain in the 0.09–0.17 range. Big variants should
   run 800–1600ms; small variants 400–700ms.
3. Register in `VERDICT_GREEN_VARIANTS`:
   ```ts
   my_new_style: {
     id: "my_new_style",
     name: "My New Style",
     description: "Short user-facing blurb (~10 words).",
     synthGreen: synthMyNewStyleGreen,
     synthBigGreen: synthMyNewStyleBigGreen,
   },
   ```
   Insertion order = display order in `/studio/sounds`. No other UI
   changes are needed — `VERDICT_GREEN_VARIANT_LIST` is derived from
   `Object.values(VERDICT_GREEN_VARIANTS)`.
4. TypeScript enforces registry/union consistency. The getters
   (`getActiveVerdictGreenVariant`) validate stored IDs against the
   registry keys, so an old localStorage value pointing at a deleted
   variant will safely fall back to the default.

For red, just drop the "Big" pair — `VerdictRedVariantMeta` has a
single `synth` field.

---

## Pre-existing fixes rolled in

These weren't caused by the verdict work but were blocking `next
build`, so they're fixed here to leave the tree green:

### `components/studio/CelebrationOverlay.tsx`

`<Lottie speed={LOTTIE_SPEED} ... />` no longer compiles — the prop
was removed from `lottie-react` typings. Replaced with an imperative
call in `useEffect`:

```tsx
const lottieRef = useRef<LottieRefCurrentProps>(null);

useEffect(() => {
  lottieRef.current?.setSpeed(LOTTIE_SPEED);
}, []);

return <Lottie lottieRef={lottieRef} ... />;
```

### `lib/studio/skyCrackers.ts`

`canvas-confetti`'s default import typing changed. The old
`typeof import("canvas-confetti").default` no longer resolves. Fixed
by:

- Retyping to `type ConfettiFn = typeof import("canvas-confetti");`
- Making `getConfetti()` handle both interop shapes at runtime:
  ```ts
  confettiPromise = import("canvas-confetti").then((m) => {
    const mod = m as unknown as ConfettiFn & { default?: ConfettiFn };
    return mod.default ?? mod;
  });
  ```

---

## Known non-issues (don't waste time investigating)

- **`next lint` prompts interactively.** The repo has no ESLint
  config wired up. Not a regression. `npm run build` (which runs
  the TS check) is the enforced gate.
- **`.next/trace` may reference `VerdictReactiveV2.tsx`.** Stale
  webpack trace from before the promotion. Gets overwritten on the
  next dev-file save. `VerdictReactiveV2.tsx` was deleted; its
  contents live in `VerdictReactive.tsx` now.
- **`STUDIO_TIMING.VERDICT_BEGIN = 5500ms` looks arbitrary.** It's
  calibrated to fire ~970ms after the rollup ding's decay clears.
  Anything earlier steps on the ding; much later feels
  disconnected. Change together with the rollup timing if you tune
  either.

---

## Suggested follow-ups (optional, no urgency)

- **MP3 override for verdict variants.** Only click / swoosh / ding
  / rollup / cracker have MP3 override support today (via
  `startMp3Probe` in `sounds.ts` and `public/assets/sounds/*.mp3`).
  Verdict variants are synth-only. If the user wants to slot in a
  purchased sample later, extending the probe pattern to verdict is
  ~40 lines.
- **Green defaults review.** `major_bell` is a neutral pick. If a
  favourite emerges from real production use out of the 18 options,
  promote it to `DEFAULT_VERDICT_GREEN_VARIANT` so fresh installs
  land on the good one.
- **Per-variant volume normalisation pass.** Every synth has a
  `master` gain constant near the top of its function. If the user
  reports one variant is noticeably louder/quieter than its
  siblings, tweak in isolation (each synth is self-contained).
- **Analytics on variant picks.** If a `studio_variant_picked`
  event exists, wire the two new custom events
  (`studio:verdict-green-variant-changed`,
  `studio:verdict-red-variant-changed`) into it so we can see which
  variants the user actually keeps.
