# Deploying Vayu to Vercel (GitHub → auto-deploy)

Production deploys from the private GitHub repo `karthi-dk/vayu-dashboard`.
Every push to `main` triggers a Vercel production build. Preview deploys
run on other branches / PRs when enabled.

**Live URL:** [https://foliopulse.vercel.app](https://foliopulse.vercel.app)  
**Release notes:** [CHANGELOG.md](./CHANGELOG.md) (update on every ship)

## 0. Pre-flight

The auth gate and PWA are already wired. Before the first deploy, make
sure you have:

- **Auth secrets**: `APP_USERNAME`, `APP_PASSWORD`, and
  `APP_SESSION_SECRET` (32+ bytes of randomness).
  ```bash
  # Generate a fresh session secret (paste into Vercel later):
  openssl rand -base64 32
  ```
- **Supabase credentials** from Supabase Dashboard → Settings → API:
  `Project URL` and the `service_role` key.
- **Dhan token** (only if you're using `/api/sync-fund-holdings`).

## 1. GitHub repo

```bash
# From the project root (after .gitignore is in place):
git init
git add .
git commit -m "Initial commit: Vayu personal portfolio dashboard"
# Create private repo + push (gh CLI):
gh repo create vayu-dashboard --private --source=. --remote=origin --push
```

Never commit `.env.local` — it is gitignored and holds service-role /
auth secrets.

## 2. Connect Vercel to GitHub

1. Go to **https://vercel.com/new**
2. Import **`karthi-dk/vayu-dashboard`** (GitHub integration must be
   authorized for the account/org).
3. Framework: **Next.js** (not "Other" — Edge middleware needs the
   Next preset). Root directory: `.`
4. **Do not deploy yet** — add env vars first (step 3).

Or with the CLI (team Deekay):

```bash
npx vercel link --yes --project foliopulse --scope kdeekay
npx vercel git connect   # if prompted, link the GitHub repo
```

(Vercel project may appear as `foliopulse` / legacy `vayu-dashboard` —
confirm the production alias `foliopulse.vercel.app` is attached.)

## 3. Set environment variables

Vercel dashboard → **Settings** → **Environment Variables**, or
`npx vercel env add <NAME>` for each. Add:

| Variable                       | Value                                    | Source                                            |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`     | `https://<your-ref>.supabase.co`         | Supabase → Settings → API                         |
| `SUPABASE_SERVICE_KEY`         | `sb_secret_...`                          | Supabase → Settings → API → service_role (SECRET) |
| `APP_USERNAME`                 | username at `/login`                     | You invent                                        |
| `APP_PASSWORD`                 | password at `/login`                     | You invent                                        |
| `APP_SESSION_SECRET`           | `openssl rand -base64 32` output         | You invent                                        |
| `NEXT_PUBLIC_FUNDS_TEST_MODE`  | `true` / `false`                         | Studio test writes (`platform=test`); no banner   |
| `DHAN_TOKEN_ID`                | your Dhan static token                   | Dhan API dashboard (only if using)                |

For each, enable **Production** and **Preview** (and Development if you
use `vercel dev`). Then deploy — first build takes about 90 seconds.

```bash
npx vercel --prod
# or: push to main after the GitHub project is linked
```

## 4. First login

- Open **https://foliopulse.vercel.app**.
- You'll be bounced to `/login`. Enter `APP_USERNAME` + `APP_PASSWORD`.
- On success you land on the overview page. Session cookie is good for
  30 days.

## 5. Install as PWA

### Android (Chrome)

- Open the deploy URL in **Chrome on Android**.
- Chrome menu → **"Install app"** (or "Add to Home screen").
- Vayu launches standalone (no browser chrome).

### Desktop (Chrome / Edge)

- Open the production URL.
- After the service worker registers, the address bar shows
  **"Install Vayu"** (from `short_name` / `applicationName`).
- Click it to install as a desktop app.

### iOS Safari

- Share → **"Add to Home Screen"** (uses `apple-touch-icon.png` +
  `appleWebApp` metadata).

PWA assets (`/manifest.webmanifest`, `/sw.js`, icons) are publicly
reachable without login so Chrome can validate installability.

The service worker is an installability shim only — it does **not**
cache pages or API data. After a production deploy, reopen the
installed app (or hard-refresh) to load the new build.

## 6. Redeploying after code changes

1. Update **[CHANGELOG.md](./CHANGELOG.md)** (`[Unreleased]` → version
   section) and bump `package.json` `version` when cutting a release.
2. Commit and push `main` — Vercel rebuilds and promotes production.

```bash
git add -A && git commit -m "…" && git push origin main
# optional release tag:
git tag v0.2.0 && git push origin v0.2.0
```

Rotating secrets:

- Change `APP_PASSWORD` → save in Vercel (redeploy if needed).
  **Existing sessions still work** — they are signed with
  `APP_SESSION_SECRET`, not the password.
- To force re-login for everyone, rotate `APP_SESSION_SECRET` and
  redeploy.

## Known limits on Hobby plan

### 1. `maxDuration = 30` clamps to 10s on Hobby

Five routes set `maxDuration = 30` in their file headers:

- `app/api/refresh-mf-nav/route.ts`
- `app/api/refresh-index-levels/route.ts`
- `app/api/sync-nps/apply/route.ts`
- `app/api/sync-nps/preview/route.ts`
- `app/api/sync-fund-holdings/[isin]/route.ts`

**Hobby hard-caps serverless execution at 10 seconds.** If a route
hits the cap on cold start: upgrade to Pro, optimise the route, or
move work off the request path.

### 2. Cron jobs are disabled

`vercel.json` no longer defines daily NAV crons because
`middleware.ts` would 307 them to `/login`. Manual NAV refresh via
the top-nav "NAVs" button still works. To re-enable crons see the
comment inside `vercel.json`.

## Uninstalling

- Vercel → Project → **Settings** → **Delete Project**. Supabase data
  is untouched.
- Rotate all sessions without deleting: change `APP_SESSION_SECRET` →
  redeploy.
