// Extended Internal Rate of Return (XIRR) — a Newton-Raphson solver over
// dated, signed cash flows, with a bisection fallback for cases where
// Newton's method fails to converge.
//
// Sign convention (matches Excel / Google Sheets XIRR):
//   • negative amount = money OUT of your pocket (an investment)
//   • positive amount = money INTO your pocket (a redemption, or the
//     terminal "what it's worth today" flow)
//
// Day-count convention: actual calendar days from the EARLIEST flow date,
// divided by 365 (not 365.25) — again matching Excel's XIRR, so numbers
// computed here are directly comparable to what Groww/Excel would report
// for the same cash-flow list.

export type CashFlow = { date: string; amount: number };

const MAX_NEWTON_ITER = 100;
const NEWTON_TOL = 1e-7;
const MAX_BISECT_ITER = 200;
const BISECT_TOL = 1e-7;

function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

/** Net present value of `flows` at rate `r`, discounted from `t0`. */
function npv(flows: CashFlow[], t0: string, r: number): number {
  return flows.reduce((sum, f) => {
    const years = daysBetween(t0, f.date) / 365;
    return sum + f.amount / Math.pow(1 + r, years);
  }, 0);
}

/** d(NPV)/dr — used by Newton-Raphson to pick the next step. */
function dNpv(flows: CashFlow[], t0: string, r: number): number {
  return flows.reduce((sum, f) => {
    const years = daysBetween(t0, f.date) / 365;
    if (years === 0) return sum;
    return sum - (years * f.amount) / Math.pow(1 + r, years + 1);
  }, 0);
}

/**
 * Solve for XIRR given a list of dated, signed cash flows.
 *
 * Returns null (rather than throwing) when the input can't produce a
 * mathematically valid rate — mirrors Excel's #NUM! failure modes:
 *   • fewer than 2 flows
 *   • every flow shares one date (no time value to solve a rate over)
 *   • every flow shares one sign (no root exists)
 *   • the solver fails to converge within its iteration budget
 *
 * Returns the ANNUALIZED rate as a decimal (0.1462 = 14.62%).
 */
export function computeXirr(flows: CashFlow[]): number | null {
  if (flows.length < 2) return null;

  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const t0 = sorted[0].date;

  if (!sorted.some((f) => f.date !== t0)) return null; // all one date
  const hasPositive = sorted.some((f) => f.amount > 0);
  const hasNegative = sorted.some((f) => f.amount < 0);
  if (!hasPositive || !hasNegative) return null; // all one sign

  // Newton-Raphson, seeded at 10% — a reasonable prior for investment
  // cash-flow shapes and the default most XIRR implementations use.
  let r = 0.1;
  let converged = false;
  for (let i = 0; i < MAX_NEWTON_ITER; i++) {
    const f = npv(sorted, t0, r);
    if (Math.abs(f) < NEWTON_TOL) {
      converged = true;
      break;
    }
    const df = dNpv(sorted, t0, r);
    if (df === 0 || !Number.isFinite(df)) break;
    const rNext = r - f / df;
    // (1+r) going negative makes Math.pow return NaN for fractional
    // exponents — guard against Newton overshooting past -100%.
    if (!Number.isFinite(rNext) || rNext <= -0.999999) break;
    if (Math.abs(rNext - r) < NEWTON_TOL) {
      r = rNext;
      converged = true;
      break;
    }
    r = rNext;
  }
  if (converged && Number.isFinite(r)) return r;

  // Newton failed to converge (rare — usually a bad seed region for an
  // unusual cash-flow shape). Fall back to bisection over a wide bracket.
  // For the "invest repeatedly, observe one terminal value" shape this
  // module is built for, NPV(r) is strictly monotonically decreasing, so
  // bisection is guaranteed to find the unique root if one exists in the
  // bracket.
  let lo = -0.99;
  let hi = 10;
  let fLo = npv(sorted, t0, lo);
  let fHi = npv(sorted, t0, hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) {
    hi = 100; // widen once more for unusually large/long-dated terminal values
    fHi = npv(sorted, t0, hi);
    if (!Number.isFinite(fHi) || fLo * fHi > 0) return null;
  }

  for (let i = 0; i < MAX_BISECT_ITER; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(sorted, t0, mid);
    if (Math.abs(fMid) < BISECT_TOL || hi - lo < BISECT_TOL) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return null;
}
