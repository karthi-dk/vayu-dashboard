# TODO

Durable backlog — survives across chat sessions, unlike the in-session
TodoWrite list. Add new items with enough context that a future session
(me or another agent) can pick them up cold without re-deriving the
reasoning from scratch.

---

## MF: XIRR + entry-price analysis (per fund + total portfolio)

Requested 2026-07-23, following the NPS XIRR build (`lib/xirr.ts` +
`computeNpsXirr` in `lib/queries.ts`, badge on `NpsGrowthBreakdown`).
Three related asks, do them together since they share data:

> **STATUS (2026-07-31):** items 2 + 3 SHIPPED as the "My avg NAV /
> Index NAV / vs Index" columns on the Portfolio Fund-holdings table
> (`attachEntryPriceAnalysis` in `lib/queries.ts` +
> `components/portfolio/HoldingsTable.tsx`). Item 1 (MF XIRR) is still
> open.

### 1. MF XIRR — per fund AND total MF portfolio

Same `computeXirr()` solver in `lib/xirr.ts` — no new math needed, just a
new cash-flow builder analogous to `computeNpsXirr`, fed from
`mf_transactions` instead of `nps_transactions`.

**The one thing to get right — mirrors the NPS switch_in/switch_out
nuance exactly:**

| Scope | `switch_in` / `switch_out` |
|---|---|
| **Per-fund XIRR** | ✅ INCLUDE — a switch_in to Fund X is real money entering Fund X from elsewhere, even though it's not new money into the portfolio. Treat like a purchase/redemption for that fund's own cash-flow list. |
| **Total portfolio XIRR** | ❌ EXCLUDE — money moving between funds you already hold nets to zero at the portfolio level. Same logic as NPS's scheme_in/scheme_out exclusion at the Tier I aggregate. |

Also check the exact `tx_type` vocabulary in `mf_transactions`
(`purchase`, `sip_registration`, `sip_cancellation`, `redemption`,
`switch_in`, `switch_out`, possibly more — re-read
`migrations/2026-07-18-mf-transactions.sql`'s tx_type comment before
writing the filter). `sip_registration`/`sip_cancellation` carry
`amount = 0` — harmless if included, but cleaner to exclude explicitly.

Terminal flow: `fund_holdings.current_value_inr` per fund (for per-fund
XIRR) or the summed total (for portfolio XIRR) — reuse whatever `nw_daily`
/ `fund_holdings` field the rest of the app already treats as ground
truth for "current value," same principle as NPS reusing
`nw_daily.nps_value` rather than inventing a second "current value"
definition.

**Trust calibration reminder (from the 2026-07-23 conversation) — do not
skip this when building the UI:** XIRR is only a *reliable* signal past
~3 years of span; 1 year is an improvement over 6 months but still not
"accurate" in the trustworthy sense. Show the badge whenever it's
computable (per computeXirr's contract), same as NPS — but if there's
ever a "how good is this fund" framing in copy, don't imply a <3yr number
is decision-grade.

### 2. My average entry NAV (per fund) — DONE 2026-07-31

Cost basis per unit, computed from MY OWN transactions:

```
avgEntryNav = Σ(amount paid on purchase/sip rows) / Σ(units acquired on those rows)
```

Equivalent to Groww/INDmoney's own `averageNav` / `average_price` field
(seen in the INDmoney portfolio JSON earlier this session — e.g.
`"averageNav": 34.8529` for HDFC Short Term Debt). Computing it ourselves
from `mf_transactions` is worth doing anyway because:
- it's fully transparent (verifiable against the raw ledger)
- it works even for funds/folios external platforms don't track live
  (e.g. only visible via CAS)
- it's a natural sanity-check cross-reference against Groww/INDmoney's
  own number — if they diverge meaningfully, that's a data-quality signal
  worth investigating (missing transactions, wrong sign, etc.)

Exclude `redemption` from the numerator/denominator of the *entry* price
(redemptions are an exit price question, not an entry price question) —
unless there's a reason to track "average exit NAV" too, which wasn't
asked for here but is the natural symmetric extension if it comes up.

### 3. How close is my average entry NAV to the fund's own average NAV over the same period? — DONE 2026-07-31

This is the one that actually *measures* whether the "flood with 280
entries/year" SIP strategy discussed in this session's conversation
worked — i.e., did spreading purchases out reduce personal timing luck,
or did the fund's own average NAV over that window come out meaningfully
different from what I actually paid?

```
fundAvgNav(fundCode, startDate, endDate) =
  mean(mf_nav_history.nav WHERE fund_code = X AND date BETWEEN [startDate, endDate])
```

- `startDate`/`endDate` = first and last `mf_transactions` date for that
  fund (i.e., the exact window I was actually buying in — not some
  arbitrary calendar range).
- Compare `avgEntryNav` (item 2) against `fundAvgNav` for the same
  window. Report as a % difference — negative means I bought *below*
  the period average (good), positive means *above* (bad).
- Simple arithmetic mean of daily NAV is the natural starting point;
  a units-weighted or day-weighted average is a possible refinement if
  the simple mean turns out to disagree meaningfully with intuition, but
  don't over-build this on the first pass — simple mean first, iterate
  only if it's visibly wrong on inspection.

`mf_nav_history` already exists (`migrations/2026-07-18-mf-daily-
reconstruction.sql`, keyed by `fund_code` + `date` + `nav`) — no backfill
needed to start this, same as items 1 and 2.

### Suggested surfacing

- Per-fund: natural home is a per-fund drill-down (the existing
  `FundDetailsModal` pattern in `components/sync/FundDetailsModal.tsx`,
  or wherever fund-level detail already renders) — add avgEntryNav,
  fundAvgNav-over-window, and the % delta as a small stat block, plus
  per-fund XIRR if there's room.
- Portfolio-level: XIRR badge on `MFGrowthBreakdown`'s header, matching
  the `NpsGrowthBreakdown` pattern exactly (same badge styling, same
  "not range-reactive — computed once over full ledger" reasoning).

### Files likely touched

- `lib/queries.ts` — new `computeMfXirr()` (per-fund + portfolio
  variants), `computeAvgEntryNav()`, `computeFundAvgNavOverWindow()`.
  Reuses `computeXirr` from `lib/xirr.ts` — no changes needed there.
- `components/overview/MFGrowthBreakdown.tsx` — XIRR badge (mirror
  `NpsGrowthBreakdown`'s header change from 2026-07-23).
- Per-fund modal (TBD which one) — avgEntryNav / fundAvgNav / delta stat
  block.

---

## Studio: content-creation enhancements (deferred)

Raised 2026-07-30. Two ideas were discussed but explicitly parked for
later — no code shipped for either yet.

### 2. Cinema calibration timer / slow-motion toggle

**Problem it solves:** the reveal waterfall runs on a 4s budget
(`STUDIO_TIMING` in `components/studio/RevealDashboard.tsx`). Screen
recorders capture it fine at 60fps, but there's no *editing* headroom:
you can't cleanly slow a fast clip in post (frame interpolation ghosts),
and there's no breathing room for a voiceover walking through the chart
draw / roll-up / verdict beats. Slowing the source is the fix.

**Shape of the feature:** a global speed multiplier (e.g. 1x / 0.5x /
0.25x) that scales the whole ceremony in lockstep so audio + visuals stay
sample-aligned:
- Multiply every `STUDIO_TIMING` value (or wrap reads in a
  `scale(ms)` helper) — `CHART_DURATION`, `PILL_*`, `STATS_*`,
  `ROLLUP_SOUND_BEGIN`, `TOTAL_ORDERS_SETTLE`, `VERDICT_BEGIN`. These
  already flow to children via props, so one dial should cascade.
- Lottie: call `setSpeed()` in `components/studio/CelebrationOverlay.tsx`
  with the same multiplier (it currently derives `LOTTIE_SPEED` from a
  fixed target duration — factor the multiplier in there).
- Audio: the synths in `lib/studio/sounds.ts` are scheduled against the
  same clock; verify the rollup/ding/verdict still line up when slowed
  (they may need their own scheduled offsets scaled, not just the visual
  timings). This is the fiddly part — the audio is tuned to land on
  specific tile-settle frames.
- Surface the control via a `?speed=0.5` URL param so it's scriptable
  and doesn't add on-camera chrome.

**Gotcha:** `prefers-reduced-motion` users already get the static Skip
path via `RollUpNumber` — the slow-mo dial should only affect the
animated (Submit / Replay) path.

### 4. Same-frame theme switching (hotkeys + mobile gesture)

**Problem it solves:** to record a seamless "theme morph" cut, the
creator needs to swap Classic → Clay → Glass → Soft → Skeuo without
navigating an on-screen menu (which breaks the shot).

**Shape of the feature:**
- Desktop / device-mode capture: bind number keys `1–5` to the
  `STUDIO_THEMES` entries in `lib/studio/themes.ts` and `R` to reset the
  reveal from t=0 (bump the `replayCount` remount key in
  `RevealDashboard.tsx`). Keydown listener on `window`, scoped to
  `/studio*`, ignored when an input/select is focused.
- Physical mobile (no keyboard): a discreet gesture, e.g. triple-tap the
  "Studio" title (or a 2-finger tap anywhere) cycles to the next theme.
  Keep it invisible so it never shows in a recording — this is the
  mobile-first counterpart to the hotkeys since the Studio screen is
  primarily a phone surface.
- Navigation currently uses `<Link>` (route change per theme). Hotkey /
  gesture handlers can `router.push()` the next theme's href instead.
