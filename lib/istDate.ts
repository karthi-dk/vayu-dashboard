/**
 * IST (Asia/Kolkata) date helpers.
 *
 * This is a personal India-focused portfolio dashboard. Every calendar-day
 * value stored (nw_daily.date, EPF last_verified_date, NPS last_units_update,
 * etc.) should represent the day the *user* experienced, not the UTC day.
 *
 * BUG THIS PREVENTS
 * -----------------
 * `new Date().toISOString().slice(0, 10)` returns UTC's date. At 12:07 AM
 * IST on Jul 15, that's 6:37 PM UTC on Jul 14 — so slice(0,10) returns
 * "2026-07-14". A user syncing at that moment would silently overwrite
 * yesterday's row in nw_daily with today's values. Discovered 2026-07-15
 * when the Overview chart showed only 2 points instead of 3.
 *
 * Any sync between 00:00 and 05:29 IST is affected (IST = UTC + 5:30).
 *
 * WHY Intl.DateTimeFormat AND NOT MANUAL OFFSET ARITHMETIC
 * --------------------------------------------------------
 * `new Date(now.getTime() + 5.5 * 3600 * 1000)` would work today because
 * IST has no DST, but it's brittle — anyone porting this code for other
 * regions would silently get wrong dates for DST periods. Using
 * `Intl.DateTimeFormat` with an explicit timeZone is the standard,
 * DST-safe, locale-independent approach.
 *
 * en-CA locale is used because it happens to format as YYYY-MM-DD, which
 * is exactly what Postgres DATE columns expect. en-US would give
 * "07/15/2026", which we'd have to reparse.
 */

export function istDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
