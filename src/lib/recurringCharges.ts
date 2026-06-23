/**
 * Recurring / subscription-charge detection from imported statements (TASK 82).
 *
 * Given the normalized statement lines (see statementMatch.ts), group them by a
 * normalized merchant key and flag groups that look like a SUBSCRIPTION: the
 * same (or near-same) amount recurring for the same merchant at least N times.
 * We also estimate the cadence (median gap in days) so the UI can say "~monthly"
 * etc. This surfaces "you're still paying for this" charges the user may have
 * forgotten.
 *
 * Pure / unit-testable — operates on plain statement lines, no DB / network.
 */
import type { RecurringCharge } from '@/types';
import type { RawStatementLine } from './statementMatch';

/** Normalize a merchant description into a stable grouping key. */
export function merchantKey(description: string): string {
  return (description || '')
    .toLowerCase()
    // Drop common trailing transaction noise (store numbers, refs, dates, cities).
    .replace(/[#*]/g, ' ')
    .replace(/\b\d{2,}\b/g, ' ') // long digit runs (store/ref numbers)
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    // Drop short tokens (state codes like "CA", stray initials) that vary
    // between otherwise-identical merchant descriptions.
    .filter((w) => w.length >= 3)
    // Keep the first couple of significant words so "NETFLIX.COM 866-xxx CA"
    // and "NETFLIX.COM" collapse to the same key.
    .slice(0, 2)
    .join(' ');
}

interface Indexed extends RawStatementLine {
  index: number;
}

/** Median of a numeric list (0 for empty). */
function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Most common value in a list (first-seen wins on ties). */
function mode(nums: number[]): number {
  const counts = new Map<number, number>();
  let best = nums[0];
  let bestN = 0;
  for (const n of nums) {
    const c = (counts.get(n) ?? 0) + 1;
    counts.set(n, c);
    if (c > bestN) {
      bestN = c;
      best = n;
    }
  }
  return best;
}

/**
 * Detect recurring charges.
 *
 * @param amountTolerance amounts within this absolute delta count as "the same"
 *        recurring price (covers small price bumps), default 0.50.
 * @param minOccurrences minimum charges in a group to flag it, default 2.
 */
export function detectRecurringCharges(
  lines: RawStatementLine[],
  {
    amountTolerance = 0.5,
    minOccurrences = 2,
  }: { amountTolerance?: number; minOccurrences?: number } = {},
): RecurringCharge[] {
  // Group by merchant key.
  const groups = new Map<string, Indexed[]>();
  lines.forEach((line, index) => {
    const key = merchantKey(line.description);
    if (!key) return;
    const list = groups.get(key) ?? [];
    list.push({ ...line, index });
    groups.set(key, list);
  });

  const out: RecurringCharge[] = [];

  for (const [key, items] of groups) {
    if (items.length < minOccurrences) continue;

    // Within a merchant, find the dominant amount and keep only the charges that
    // sit within tolerance of it (so a one-off large purchase at the same
    // merchant doesn't get lumped into the subscription group).
    const repAmount = mode(items.map((i) => Math.round(i.amount * 100) / 100));
    const recurring = items.filter(
      (i) => Math.abs(i.amount - repAmount) <= amountTolerance,
    );
    if (recurring.length < minOccurrences) continue;

    // Cadence: median gap between consecutive dated charges.
    const dates = recurring
      .map((i) => i.date)
      .filter((d): d is string => !!d)
      .map((d) => Date.parse(d))
      .filter((ms) => Number.isFinite(ms))
      .sort((a, b) => a - b);
    let cadenceDays: number | null = null;
    if (dates.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) {
        gaps.push(Math.round((dates[i] - dates[i - 1]) / 86400000));
      }
      const med = Math.round(median(gaps));
      cadenceDays = med > 0 ? med : null;
    }

    const lastDateMs = dates.length ? dates[dates.length - 1] : null;

    out.push({
      merchant: key,
      amount: Math.round(repAmount * 100) / 100,
      count: recurring.length,
      cadenceDays,
      lineIndexes: recurring.map((i) => i.index),
      lastDate: lastDateMs != null ? new Date(lastDateMs).toISOString().slice(0, 10) : null,
    });
  }

  // Most-frequent (then highest-amount) first so the biggest leaks float up.
  out.sort((a, b) => b.count - a.count || b.amount - a.amount);
  return out;
}

/** Human label for a cadence in days (used by the UI). */
export function cadenceLabel(days: number | null): string {
  if (days == null) return 'recurring';
  if (days >= 6 && days <= 8) return 'weekly';
  if (days >= 12 && days <= 16) return 'bi-weekly';
  if (days >= 27 && days <= 32) return 'monthly';
  if (days >= 58 && days <= 64) return 'every 2 months';
  if (days >= 85 && days <= 95) return 'quarterly';
  if (days >= 350 && days <= 380) return 'yearly';
  return `every ~${days} days`;
}
