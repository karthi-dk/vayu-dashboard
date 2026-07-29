# VAYU — Personal Portfolio Dashboard

Next.js 15 + React 19 dashboard wired to Supabase. Dark theme, indigo accent,
Outfit font. All four pages read live data from your `wtbfogmfculqnuirizip`
Supabase project.

## Stack

- **Next.js 15.3** — App Router, React Server Components + client islands
- **React 19**
- **Supabase** — `@supabase/supabase-js` for reads/writes
- **Tailwind CSS v3** — design tokens in `app/globals.css`
- **Recharts** — line, area, donut charts
- **lucide-react** — icons

## Getting started

```bash
cp .env.example .env.local   # fill in Supabase URL + anon key
npm install
npm run dev
```

Open **[http://localhost:5000](http://localhost:5000)**.

`npm run dev` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` **for local dev only** —
needed if a corporate SSL proxy intercepts HTTPS (common on Nike/corp networks).
Vercel production does not need this.

For production:

```bash
npm run build
npm start   # also serves on port 5000
```

### Packaging the project for handover

```bash
npm run zip     # → vayu-dashboard.zip (~800 KB)
```

The script excludes `node_modules`, `.next`, `.git`, `.env.local`, and
build caches — everything the receiver can regenerate from
`package-lock.json` and `npm run build`. After unzipping, run
`npm install` and follow the "Getting started" steps above.

## Deploy (GitHub → Vercel)

Production ships from the private GitHub repo via Vercel Git integration
(push to `main` → production deploy). Full runbook: **[DEPLOY.md](DEPLOY.md)**.

PWA install is already wired (`manifest.webmanifest`, `/sw.js`, icons).
On the HTTPS production URL: Android Chrome → Install app; desktop
Chrome/Edge → **Install Vayu** in the address bar.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | server + browser (URL only, not credential) | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | **server only** — never exposed to browser | Every DB read/write — bypasses RLS |
| `APP_USERNAME` | server only | Login username |
| `APP_PASSWORD` | server only | Login password |
| `APP_SESSION_SECRET` | server only | HMAC key for session cookies |
| `NEXT_PUBLIC_FUNDS_TEST_MODE` | server + browser | Studio test-mode banner / isolation |
| `DHAN_TOKEN_ID` | server only | Fund holdings resync via Dhan API |

## Security model

The dashboard is single-user and **never sends DB credentials to the browser**.
All Supabase access happens in server code (Route Handlers, Server Actions,
Server Components, and `lib/queries.ts`). The browser only talks to Next.js
API routes; those API routes talk to Supabase using the `service_role` key.

- `lib/supabase.ts` imports `"server-only"` — Next.js throws a build error
  if any client component pulls it in.
- Every table has RLS enabled with zero policies → anon key gets denied
  everywhere. Service role bypasses RLS, so server code works normally.
- The anon key isn't shipped to the browser bundle anymore (no
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.example`).

### First-time RLS lockdown (one-time migration)

Follow this order — the sequence matters. Doing SQL before env kills the app.

1. **Get the service_role key**
   Supabase Dashboard → Settings → API → copy **`service_role`** secret.

2. **Add to `.env.local`**
   ```
   SUPABASE_SERVICE_KEY=eyJ...   # the service_role secret from step 1
   ```
   (`NEXT_PUBLIC_SUPABASE_ANON_KEY` can stay for now — it's no longer used,
   but removing it doesn't hurt either.)

3. **Restart `npm run dev`**
   The app should boot and every page should load exactly as before.
   If it throws "Missing SUPABASE_SERVICE_KEY", step 2 didn't take —
   check the env file and re-run.

4. **Enable RLS in Supabase**
   Dashboard → SQL Editor → paste `migrations/2026-07-18-enable-rls.sql`
   → Run. Then paste the `SELECT ... FROM pg_tables` verification query
   from the same file — you should see 12 rows, all `rls_enabled = true`
   and `policy_count = 0`.

5. **Verify browser can't talk to Supabase directly**
   Open DevTools → Network → refresh a page. You should see requests to
   `/api/*` on your own domain — **zero** requests to `*.supabase.co`.
   Bonus: try the raw REST API from a terminal with your old anon key —
   it should return an empty array or 401 for every table:
   ```bash
   curl "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/fund_holdings?select=*" \
     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
   # → []   (RLS denied, but PostgREST hides that as an empty result)
   ```

6. **(Optional) Rotate the anon key**
   Now that RLS gates it anyway, rotating gives a clean baseline in case
   the old key leaked while RLS was off. Dashboard → Settings → API →
   rotate. No app code change needed since we no longer use it.

### Adding a new table later

New tables ship with RLS **off** by default. Add these two lines to any
new migration or run them in the SQL editor once:

```sql
CREATE TABLE my_new_table (...);
ALTER TABLE my_new_table ENABLE ROW LEVEL SECURITY;
```

No policies = deny-all for anon; service role still works. Same pattern
as the existing 12 tables.

## Pages

| Route | Data source |
|---|---|
| `/` | `nw_daily`, `nps_state`, `epf_state`, `fund_holdings`, `portfolio_config` |
| `/portfolio` | `fund_holdings`, `fund_holdings_detail`, `master_security_classification` |
| `/sync` | Groww paste → `POST /api/sync-groww`; per-fund resync → `POST /api/sync-fund-holdings/{isin}` |
| `/settings` | `nps_state`, `epf_state`, `portfolio_config` + server actions |

## API routes

- **`POST /api/sync-groww`** — paste Groww portfolio JSON, upserts `fund_holdings`, recomputes `nw_daily`
- **`POST /api/sync-fund-holdings/[isin]`** — fetch from Dhan, classify against `master_security_classification`, atomic replace via `replace_fund_holdings` RPC

## Studio — mobile order entry with cinematic reveal

`/studio` is a self-contained MF-purchase-logging experience distinct from
the main dashboard. Mobile-first, one-fund-per-session, and heavy on
motion + audio feedback. Same reveal pipeline is also mounted under three
alternate skins for A/B comparison:

- `/studio` (default)
- `/studio/claymorphic`
- `/studio/glassmorphic`
- `/studio/neumorphic`

### Reveal pipeline

Once the user submits an order, the sequence fires against a shared clock
(`STUDIO_TIMING` in `components/studio/RevealDashboard.tsx`):

| t (ms) | Beat | Sound | Source |
|-------:|------|-------|--------|
| 0 | Cracker | sky-cracker synth | `lib/studio/skyCrackers.ts` + confetti |
| 1600 | Value pill lands | `ding` | `synthDing` |
| 2000 | Rollup begins | rollup synth | active rollup variant |
| ~3800 | Stats row settles | — | `StatsRow` staggered reveal |
| 5500 | Verdict | verdict synth | active green/red variant |

`RevealDashboard.tsx` is the choreographer — treat it as source of truth
when tuning timing.

### 1 DAY verdict

The 1 DAY tile in `StatsRow` settles with a sign-tiered audiovisual coda
at t≈5500ms (≈970ms of silence after the rollup ding decays). The
taxonomy has **4 tiers**, resolved by `resolveVerdictTier(oneDayInr,
oneDayPct)` in `lib/studio/sounds.ts`:

- **`big-green`** (>+1% day) — dense triple-bounce + dual-ring emerald
  halo + 12 sparkles, paired with the extended chime of the active
  green variant.
- **`green`** (any positive day up to +1%) — standard double-bounce +
  single-ring emerald halo + 8 sparkles, paired with the compact chime
  of the same green variant.
- **`flat`** (|Δ|<₹1 or |%|<0.05%) — silent, no visual.
- **`red`** (any negative day, regardless of magnitude) — heavy-dense
  pre-recoil wince → deep collapse → multi-stage recovery + triple-ring
  red halo, paired with the descent of the active red variant. Losses
  are single-tiered by design — a bad day shouldn't escalate visually
  the way a great day escalates.

Tuning surfaces:

- **`/studio/verdict`** — preview page. Fires each tier on demand and
  cycles them side-by-side.
- **`/studio/sounds`** — sound lab. Pick the sound variant for each
  side. Green variants have dual Play buttons (Small = compact synth
  for `green`, Big = extended synth for `big-green`) so users can
  audition how the style scales.

### Sound variants

Five families, each localStorage-backed and picker-driven from
`/studio/sounds`:

| Family | localStorage key | Default | Count |
|--------|------------------|---------|-------|
| Click | `studio.clickVariant` | `layered` | 10 |
| Rollup | `studio.rollupVariant` | `odometer` | 15 |
| Sky-cracker | `studio.crackerVariant` | `rocket_whistle` | 16 |
| Verdict green | `studio.verdictGreenVariant` | `major_bell` | 18 |
| Verdict red | `studio.verdictRedVariant` | `minor_descent` | 18 |

All 77 variants are Web Audio synths — no MP3 assets required. Drop
optional overrides at `public/assets/sounds/{click,swoosh,ding,rollup,cracker}.mp3`
to replace those five specific one-shots; verdict variants are
synth-only.

Registries and getters/setters all live in `lib/studio/sounds.ts`. See
[HANDOVER.md](./HANDOVER.md) for the design rationale and the recipe for
adding a new variant.

## File layout

```
vayu-dashboard/
├── app/
│   ├── page.tsx                 # Overview (async RSC)
│   ├── portfolio/page.tsx
│   ├── sync/page.tsx
│   ├── settings/page.tsx
│   ├── credits/                 # Credit-log page
│   ├── filings/                 # Filings page
│   ├── login/                   # Password-only login
│   ├── studio/
│   │   ├── page.tsx             # Default reveal
│   │   ├── {claymorphic,glassmorphic,neumorphic}/
│   │   ├── verdict/             # Tier preview / A-B page
│   │   ├── sounds/              # Sound-variant picker UI
│   │   ├── data.ts              # StudioData assembly + server actions
│   │   └── actions.ts           # Order-submit server actions
│   ├── actions.ts               # Server actions (EPF/NPS/rotation saves)
│   ├── error.tsx                # Friendly error UI (incl. SSL proxy hint)
│   └── api/
│       ├── sync-groww/route.ts
│       └── sync-fund-holdings/[isin]/route.ts
├── lib/
│   ├── supabase.ts              # sbServer (service_role, server-only)
│   ├── queries.ts               # Typed fetchers for all 4 pages
│   ├── recomputeNwDaily.ts      # Shared NW upsert helper
│   ├── fundIsin.ts              # fund_code ↔ scheme ISIN map
│   ├── studio/
│   │   ├── sounds.ts            # All 5 variant families + verdict router
│   │   └── skyCrackers.ts       # canvas-confetti wrapper
│   └── utils.ts
└── components/                  # UI by page (props-driven, no mock data)
    └── studio/
        ├── RevealDashboard.tsx  # Choreographer (STUDIO_TIMING lives here)
        ├── StatsRow.tsx         # 6-tile grid; wraps 1 DAY in VerdictReactive
        ├── VerdictReactive.tsx  # Visual tier keyframes
        ├── CelebrationOverlay.tsx  # Lottie fireworks
        └── ...
```

## Notes

- **`nw_daily` has 1 row** as of Jul 2026 — trend charts show an empty-state until more daily snapshots accumulate via the 2 AM cron or Groww syncs.
- **Emergency FD** (₹5 L) is excluded from NW everywhere per project rules.
- **Dark mode toggle** in nav is visual only — app is dark-first.
- Deploy to **Vercel** with the four env vars above. `next build` is the deploy gate.

## Design tokens

Defined as HSL CSS custom properties in `app/globals.css`:

- `--background: 240 20% 4%` — near-black
- `--primary: 248 85% 72%` — indigo accent
- `--success` / `--danger` / `--warning` — gain/loss/alert colors

Tweak any token to re-theme without touching component code.
