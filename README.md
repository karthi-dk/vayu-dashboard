# VAYU — Personal Portfolio Dashboard

Next.js 15 + React 19 dashboard wired to Supabase. Dark theme, indigo accent,
Outfit font. Live data from the `wtbfogmfculqnuirizip` Supabase project.

**Production:** [https://foliopulse.vercel.app](https://foliopulse.vercel.app)  
**Release log:** [CHANGELOG.md](./CHANGELOG.md) · **Deploy runbook:** [DEPLOY.md](./DEPLOY.md) · **Agent handoff:** [HANDOVER.md](./HANDOVER.md)

## Stack

- **Next.js 15.3** — App Router, React Server Components + client islands
- **React 19**
- **Supabase** — `@supabase/supabase-js` for reads/writes
- **Tailwind CSS v3** — design tokens in `app/globals.css`
- **Recharts** — line, area, donut charts
- **lucide-react** — icons
- **PWA** — installable on Android / desktop / iOS (no offline data cache)

## Getting started

```bash
cp .env.example .env.local   # fill in Supabase URL + service key + auth
npm install
npm run dev
```

Open **[http://localhost:5000](http://localhost:5000)**.

`npm run dev` / `npm start` use `cross-env` so
`NODE_TLS_REJECT_UNAUTHORIZED=0` works on Windows and Unix. That flag is
**for local SSL-proxy environments only** — Vercel production does not
need it.

For a production-like local build:

```bash
npm run build
npm start   # port 5000
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

Before each release: add notes under `[Unreleased]` in
**[CHANGELOG.md](./CHANGELOG.md)**, cut a version section (and bump
`package.json` `version`) in the same commit as the ship.

PWA install is already wired (`manifest.webmanifest`, `/sw.js`, icons).
On the HTTPS production URL: Android Chrome → Install app; desktop
Chrome/Edge → **Install Vayu** in the address bar. Installed PWAs always
fetch the live site (service worker does not cache HTML/API) — reopen
after a deploy to pick up the new build.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | server + browser (URL only, not credential) | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | **server only** — never exposed to browser | Every DB read/write — bypasses RLS |
| `APP_USERNAME` | server only | Login username |
| `APP_PASSWORD` | server only | Login password |
| `APP_SESSION_SECRET` | server only | HMAC key for session cookies |
| `NEXT_PUBLIC_FUNDS_TEST_MODE` | server + browser | When `true`, Studio submits use `platform=test` (isolated from headline math). No UI banner — purge rows from Sync. |
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
| `/sync` | Groww paste, MF tx logger, **Studio test-data purge**, NPS CRA, NAV refresh, fund resync |
| `/settings` | `nps_state`, `epf_state`, `portfolio_config` + server actions |
| `/credits` | Retirement credit ledger |
| `/filings` | ITR / filings browser |
| `/studio*` | Mobile MF order entry + cinematic reveal (see below) |

## Navigation (responsive)

- **`lg+`:** full horizontal TopNav (Studio dropdown + routes + freshness
  chips + refresh + theme + sign out).
- **Below `lg`:** compact bar + hamburger sheet (`MobileNav`, portaled
  to `document.body` so TopNav `backdrop-blur` cannot clip it). Theme
  and sign out live in the sheet footer.
- Soft navigations show a top progress bar (`NavigationProgress`) and
  `app/loading.tsx` while the next route loads.

## API routes

- **`POST /api/sync-groww`** — paste Groww portfolio JSON, upserts `fund_holdings`, recomputes `nw_daily`
- **`POST /api/sync-fund-holdings/[isin]`** — fetch from Dhan, classify against `master_security_classification`, atomic replace via `replace_fund_holdings` RPC

## Studio — mobile order entry with cinematic reveal

`/studio` is a self-contained MF-purchase-logging experience distinct from
the main dashboard. Mobile-first, one-fund-per-session, and heavy on
motion + audio feedback. Same reveal pipeline is also mounted under three
alternate skins for A/B comparison:

- `/studio` (default / Classic)
- `/studio/claymorphic`
- `/studio/glassmorphic`
- `/studio/neumorphic`

Theme deep links also appear in TopNav (desktop Studio dropdown) and the
in-studio theme pill (`StudioThemeSwitch`).

When `NEXT_PUBLIC_FUNDS_TEST_MODE=true`, submits force `platform=test`
(no holdings / NW side effects). Delete those rows from **Sync → Studio
test data**.

### Reveal pipeline

Once the user submits an order, celebration Lottie plays, then the
reveal sequence fires against a shared clock (`STUDIO_TIMING` in
`components/studio/RevealDashboard.tsx`). Confetti overlay is portaled
and layout-stable to avoid first-frame mis-centering.

`RevealDashboard.tsx` is the choreographer — treat it as source of truth
when tuning timing. Temporary **Replay** control is gated by
`SHOW_STUDIO_REPLAY` (on for recording; turn off when done).

### Sound variants

Five families, each localStorage-backed and picker-driven from
`/studio/sounds`. Registries live in `lib/studio/sounds.ts`. See
[HANDOVER.md](./HANDOVER.md) for verdict design rationale and the recipe
for adding a new variant.

## File layout

```
vayu-dashboard/
├── CHANGELOG.md                 # Release history (keep updated on ship)
├── DEPLOY.md                    # Vercel / GitHub runbook
├── HANDOVER.md                  # Agent / teammate context snapshot
├── app/
│   ├── loading.tsx              # Route-level nav fallback
│   ├── page.tsx                 # Overview (async RSC)
│   ├── portfolio/page.tsx
│   ├── sync/page.tsx
│   ├── settings/page.tsx
│   ├── credits/
│   ├── filings/
│   ├── login/
│   ├── studio/
│   ├── actions.ts
│   └── api/
├── components/
│   ├── nav/                     # TopNav, MobileNav, NavigationProgress
│   ├── sync/DeleteStudioTestDataCard.tsx
│   └── studio/                  # Reveal, CelebrationOverlay, …
└── lib/
```

## Notes

- **Emergency FD** (₹5 L) is excluded from NW everywhere per project rules.
- **Theme toggle** works in light/dark; mobile access is via the hamburger
  sheet footer.
- Deploy to **Vercel** with the env vars above. `next build` is the deploy
  gate. Ship notes go in **CHANGELOG.md**.
