/**
 * taxReportService — builds the Schedule-C style tax report.
 *
 * It aggregates every FINALIZED receipt plus every manual cash expense within a
 * date range, grouping them by tax category AND by currency (so multi-currency
 * users never see mismatched sums lumped together). For each group we report:
 *   - grossTotal      : sum of the gross amounts
 *   - deductibleTotal : sum of gross * deductible_percent / 100, applied
 *                       per-record so receipts that carry a different
 *                       deductible_percent than their tax category are still
 *                       counted correctly. Records whose `is_deductible` flag is
 *                       OFF contribute 0% — the flag gates the percentage, never
 *                       the other way around (receipts default to
 *                       is_deductible:false with deductible_percent:100).
 *
 * Mileage trips in range are appended as a single synthetic row: trips are fully
 * deductible at the rate stored on each trip (amount = miles * rate_per_mile,
 * kept consistent by the DAO), and carry no currency of their own, so they
 * report in the user's default currency.
 *
 * The deductible percentage shown on a row (`deductiblePercent`) is the tax
 * category's configured default — informational; the actual deductible math is
 * driven by each record's own `deductible_percent`, which the review screen
 * pre-fills from the tax category but the user may override.
 *
 * Records with no tax category fall into a synthetic "Uncategorized" group
 * (taxCategoryId === null) so nothing silently disappears from the report.
 */
import * as DB from '@/db';
import type { TaxReportRow } from '@/types';

/**
 * Synthetic id for the mileage-deduction row, so consumers can key/group it
 * without colliding with a real (or the null "Uncategorized") tax category.
 */
export const MILEAGE_ROW_ID = '__mileage__';

/** Round to 2dp, guarding against floating-point dust (mirrors db/receipts). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Label used for records that have no tax category assigned. */
const UNCATEGORIZED_NAME = 'Uncategorized';

/**
 * Accumulator keyed by `${taxCategoryId ?? '__none__'}|${currency}` so a single
 * tax category that spans multiple currencies yields one row per currency.
 */
interface Bucket {
  taxCategoryId: string | null;
  taxCategoryName: string;
  deductiblePercent: number; // the tax category's configured default
  currency: string;
  grossTotal: number;
  deductibleTotal: number;
  count: number;
}

function bucketKey(taxCategoryId: string | null, currency: string): string {
  return `${taxCategoryId ?? '__none__'}|${currency}`;
}

/**
 * Build the tax report for a date range (inclusive). Dates are ISO `YYYY-MM-DD`
 * strings; comparison is lexical, which is correct for that format.
 */
export async function buildTaxReport(opts: {
  startDate: string;
  endDate: string;
}): Promise<TaxReportRow[]> {
  const { startDate, endDate } = opts;

  // Pull the tax category catalogue once so we can resolve names + default
  // percentages without an N+1 query, and tolerate categories deleted after a
  // record referenced them.
  const taxCategories = await DB.listTaxCategories();
  const taxCatById = new Map(taxCategories.map((tc) => [tc.id, tc]));

  const buckets = new Map<string, Bucket>();

  const add = (
    taxCategoryId: string | null,
    currency: string,
    gross: number,
    recordDeductiblePercent: number,
  ): void => {
    const cur = (currency || 'USD').toUpperCase();
    const key = bucketKey(taxCategoryId, cur);
    let bucket = buckets.get(key);
    if (!bucket) {
      const tc = taxCategoryId ? taxCatById.get(taxCategoryId) : undefined;
      bucket = {
        // Keep the raw id even if the category was deleted after the record
        // referenced it, so the row still groups consistently.
        taxCategoryId,
        taxCategoryName: tc?.name ?? UNCATEGORIZED_NAME,
        deductiblePercent: tc?.deductible_percent ?? 0,
        currency: cur,
        grossTotal: 0,
        deductibleTotal: 0,
        count: 0,
      };
      buckets.set(key, bucket);
    }
    const grossAmount = Number(gross) || 0;
    const pct = clampPercent(recordDeductiblePercent);
    bucket.grossTotal += grossAmount;
    bucket.deductibleTotal += (grossAmount * pct) / 100;
    bucket.count += 1;
  };

  // --- Finalized receipts in range ---
  // listReceipts applies status + date filtering in SQL. Only receipts with a
  // resolved date participate in the date window; date-less receipts are
  // excluded because they can't be assigned to a tax year.
  const receipts = await DB.listReceipts({
    status: 'finalized',
    startDate,
    endDate,
  });
  for (const r of receipts) {
    if (!r.date) continue; // defensive: skip undated receipts
    // is_deductible gates the percentage: a receipt that isn't marked
    // deductible counts toward gross but contributes 0 to the deduction.
    add(r.tax_category_id, r.currency, r.total, r.is_deductible ? r.deductible_percent : 0);
  }

  // --- Manual cash expenses in range ---
  // CashExpenses has no date-filtered query, so we filter in JS. Every cash
  // expense has a date, so a simple inclusive lexical range works.
  const cashExpenses = await DB.CashExpenses.listCashExpenses();
  for (const ce of cashExpenses) {
    if (!ce.date) continue;
    if (ce.date < startDate || ce.date > endDate) continue;
    // Same gating as receipts: the flag decides, the percent only scales.
    add(ce.tax_category_id, ce.currency, ce.amount, ce.is_deductible ? ce.deductible_percent : 0);
  }

  // Materialize, round money fields, and sort: by deductible descending within
  // a currency, then by currency, so the biggest write-offs surface first.
  const rows: TaxReportRow[] = Array.from(buckets.values()).map((b) => ({
    taxCategoryId: b.taxCategoryId,
    taxCategoryName: b.taxCategoryName,
    deductiblePercent: b.deductiblePercent,
    grossTotal: round2(b.grossTotal),
    deductibleTotal: round2(b.deductibleTotal),
    currency: b.currency,
    count: b.count,
  }));

  // --- Mileage deduction in range ---
  // One synthetic line summing every trip's stored amount (miles * the rate
  // persisted on each trip). 100% deductible by definition — the IRS standard
  // rate IS the deduction. Filter by the trip's start date, like cash expenses.
  const trips = await DB.Mileage.listTrips();
  const tripsInRange = trips.filter((tr) => {
    const d = tr.start_time?.slice(0, 10) ?? '';
    return d >= startDate && d <= endDate;
  });
  if (tripsInRange.length) {
    const settings = await DB.getAllSettings();
    const amount = tripsInRange.reduce((s, tr) => s + (Number(tr.amount) || 0), 0);
    const miles = tripsInRange.reduce((s, tr) => s + (Number(tr.distance_miles) || 0), 0);
    rows.push({
      taxCategoryId: MILEAGE_ROW_ID,
      taxCategoryName: `Mileage deduction (${round2(miles)} mi)`,
      deductiblePercent: 100,
      grossTotal: round2(amount),
      deductibleTotal: round2(amount),
      currency: (settings.default_currency || 'USD').toUpperCase(),
      count: tripsInRange.length,
    });
  }

  rows.sort((a, b) => {
    if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
    return b.deductibleTotal - a.deductibleTotal;
  });

  return rows;
}

/** Keep a record's deductible percentage within a sane 0..100 band. */
function clampPercent(pct: number): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}
