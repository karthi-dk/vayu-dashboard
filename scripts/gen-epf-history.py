#!/usr/bin/env python3
"""
Generate the static EPF history module from EPFO passbook PDFs.

WHY A GENERATOR (not a DB table)
--------------------------------
EPF history is immutable (past FYs never change), small (~100 monthly
rows), and has no daily NAV to reconstruct — so a committed static
module is simpler and lower-risk than a DB table + migration. Re-run
this when new passbooks arrive.

SOURCE
------
/Users/kponnu/Documents/EPFO PASSBOOK — 18 passbook PDFs across 4
member IDs (FY2018-2026). Parsed with pypdf.

MODEL (verified against the ₹19,22,945 reconciliation)
------------------------------------------------------
- EPF corpus = Employee + Employer shares. PENSION (EPS) is EXCLUDED.
- Contributions = monthly "Cont." rows (emp+empr), on their credit date.
- Interest = annual "Int. Updated upto 31/03/YYYY" rows (emp+empr).
- Transfers between member IDs are internal (money stays in EPF), so
  they are NOT counted as inflows — summing each account's own
  contributions + interest across all 4 IDs already yields the corpus
  with no double-counting (the destination's transfer-in is not in its
  contribution/interest totals). Verified: no real cash withdrawals.

OUTPUT
------
lib/epf/epfHistory.generated.ts  — cumulative monthly series + totals.

Usage: python3 scripts/gen-epf-history.py
"""
import os
import re
import glob
import sys
from collections import defaultdict

try:
    import pypdf
except ImportError:
    sys.exit("pypdf not installed. Run: python3 -m pip install pypdf")

FOLDER = "/Users/kponnu/Documents/EPFO PASSBOOK"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(SCRIPT_DIR, "..", "lib", "epf", "epfHistory.generated.ts")

# Expected reconciliation targets (user-confirmed passbook total).
EXPECT_VALUE = 1922945
EXPECT_CONTRIB = 1625975
EXPECT_INTEREST = 296970


def nums(s):
    return [int(x.replace(",", "")) for x in re.findall(r"[\d,]+", s) if x.replace(",", "").isdigit()]


def iso(d, m, y):
    return f"{y}-{m:02d}-{d:02d}"


def main():
    files = sorted(glob.glob(os.path.join(FOLDER, "*.pdf")))
    if not files:
        sys.exit(f"No PDFs found in {FOLDER}")

    contrib_by_date = defaultdict(int)   # iso date -> emp+empr contribution
    interest_by_date = defaultdict(int)  # iso date -> emp+empr interest

    # Per (member, fy) verification data.
    monthly_sum = defaultdict(lambda: [0, 0])   # (mem,fy) -> [emp,empr] from monthly rows
    yearly_total = {}                            # (mem,fy) -> [emp,empr] from "Total Contributions"
    interest_line = {}                           # (mem,fy) -> [emp,empr]
    closing = {}                                 # (mem,fy) -> [emp,empr,pen]

    for f in files:
        base = os.path.basename(f)
        mm = re.match(r"([A-Z]+\d+)_(\d{4})", base)
        member, fy = mm.group(1), int(mm.group(2))
        reader = pypdf.PdfReader(f)
        text = "\n".join((p.extract_text() or "") for p in reader.pages)

        for line in text.split("\n"):
            s = line.strip()
            if not s:
                continue

            # ── Monthly contribution row ──
            # Has a dd-mm-yyyy date, is a CR credit, mentions "Cont",
            # and is NOT a transfer/claim/summary row.
            is_summary = s.startswith(("OB", "Closing", "Total", "Int.")) or \
                "TRANSFER" in s or "Claim" in s
            dmy = re.search(r"\b(\d{2})-(\d{2})-(\d{4})\b", s)
            if dmy and " CR " in f" {s} " and "Cont" in s and not is_summary:
                n = nums(s)
                if len(n) < 3:
                    continue
                emp, empr = n[-3], n[-2]  # n[-1] = pension (excluded)
                d, m, y = int(dmy.group(1)), int(dmy.group(2)), int(dmy.group(3))
                contrib_by_date[iso(d, m, y)] += emp + empr
                monthly_sum[(member, fy)][0] += emp
                monthly_sum[(member, fy)][1] += empr
                continue

            # ── Annual interest row (NOT the "OB Int." opening line) ──
            if s.startswith("Int. Updated upto"):
                dt = re.search(r"(\d{2})/(\d{2})/(\d{4})", s)
                n = nums(s)
                if not dt or len(n) < 3:
                    continue
                emp, empr = n[-3], n[-2]
                d, m, y = int(dt.group(1)), int(dt.group(2)), int(dt.group(3))
                interest_by_date[iso(d, m, y)] += emp + empr
                interest_line[(member, fy)] = [emp, empr]
                continue

            # ── Yearly summary rows for verification ──
            if "Total Contributions for the year" in s:
                n = nums(s)
                if len(n) >= 3:
                    yearly_total[(member, fy)] = n[-3:][:2]
            elif "Closing Balance as on" in s:
                n = nums(s)
                if len(n) >= 3:
                    closing[(member, fy)] = n[-3:]

    # ── VERIFY 1: monthly contributions sum to the yearly "Total Contributions" ──
    errors = []
    for key, yt in yearly_total.items():
        ms = monthly_sum.get(key, [0, 0])
        if ms != yt:
            errors.append(
                f"  {key[0]} FY{key[1]}: monthly Σ emp/empr {ms} != Total Contributions {yt}"
            )
    if errors:
        print("MONTHLY PARSE MISMATCH (monthly rows don't sum to yearly totals):")
        print("\n".join(errors))
        sys.exit(1)
    print(f"✓ Monthly contributions reconcile to yearly totals for all {len(yearly_total)} (member,FY) pairs")

    # ── Build cumulative timeline ──
    all_dates = sorted(set(contrib_by_date) | set(interest_by_date))
    history = []
    cum_c = cum_i = 0
    for d in all_dates:
        cum_c += contrib_by_date.get(d, 0)
        cum_i += interest_by_date.get(d, 0)
        history.append({"date": d, "cumContribution": cum_c,
                        "cumInterest": cum_i, "value": cum_c + cum_i})

    total_contrib = cum_c
    total_interest = cum_i
    total_value = cum_c + cum_i

    # ── VERIFY 2: grand totals match the passbook target ──
    print("\n── GRAND RECONCILIATION ──")
    print(f"  Contributions (emp+empr) : {total_contrib:>10,}  (expect {EXPECT_CONTRIB:,})")
    print(f"  Interest      (emp+empr) : {total_interest:>10,}  (expect {EXPECT_INTEREST:,})")
    print(f"  Value = C + I            : {total_value:>10,}  (expect {EXPECT_VALUE:,})")
    print(f"  Sum of latest closings   : {sum(closing[max((k for k in closing if k[0]==m), key=lambda k:k[1])][0] + closing[max((k for k in closing if k[0]==m), key=lambda k:k[1])][1] for m in set(k[0] for k in closing)):>10,}")

    assert total_contrib == EXPECT_CONTRIB, f"contrib {total_contrib} != {EXPECT_CONTRIB}"
    assert total_interest == EXPECT_INTEREST, f"interest {total_interest} != {EXPECT_INTEREST}"
    assert total_value == EXPECT_VALUE, f"value {total_value} != {EXPECT_VALUE}"
    print("✓ ALL RECONCILIATIONS PASS (₹0 difference)")

    # ── Emit TS ──
    lines = []
    lines.append("// AUTO-GENERATED by scripts/gen-epf-history.py — DO NOT EDIT BY HAND.")
    lines.append("// Source: EPFO passbook PDFs (4 member IDs, FY2018-2026). Pension (EPS) excluded.")
    lines.append("// Re-run the generator when new passbooks arrive.")
    lines.append("//")
    lines.append(f"// Reconciled: contributions ₹{total_contrib:,} + interest ₹{total_interest:,} = ₹{total_value:,}.")
    lines.append("")
    lines.append("export type EpfHistoryPoint = {")
    lines.append("  /** ISO date (YYYY-MM-DD) of the passbook event. */")
    lines.append("  date: string;")
    lines.append("  /** Cumulative EPF contributions (employee + employer) to date, in ₹. */")
    lines.append("  cumContribution: number;")
    lines.append("  /** Cumulative EPF interest (employee + employer) to date, in ₹. */")
    lines.append("  cumInterest: number;")
    lines.append("  /** Total EPF value = cumContribution + cumInterest, in ₹. */")
    lines.append("  value: number;")
    lines.append("};")
    lines.append("")
    lines.append("export const EPF_HISTORY: EpfHistoryPoint[] = [")
    for h in history:
        lines.append(
            f'  {{ date: "{h["date"]}", cumContribution: {h["cumContribution"]}, '
            f'cumInterest: {h["cumInterest"]}, value: {h["value"]} }},'
        )
    lines.append("];")
    lines.append("")
    lines.append("export const EPF_TOTALS = {")
    lines.append(f"  contributions_inr: {total_contrib},")
    lines.append(f"  interest_inr: {total_interest},")
    lines.append(f"  value_inr: {total_value},")
    lines.append("} as const;")
    lines.append("")
    lines.append("export const EPF_HISTORY_META = {")
    lines.append(f'  firstDate: "{history[0]["date"]}",')
    lines.append(f'  lastDate: "{history[-1]["date"]}",')
    lines.append(f"  points: {len(history)},")
    lines.append('  source: "EPFO passbook PDFs (pension excluded)",')
    lines.append("} as const;")
    lines.append("")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        fh.write("\n".join(lines))
    print(f"\n✓ Wrote {len(history)} points to {os.path.relpath(OUT, os.path.join(SCRIPT_DIR, '..'))}")
    print(f"  Range: {history[0]['date']} → {history[-1]['date']}")


if __name__ == "__main__":
    main()
