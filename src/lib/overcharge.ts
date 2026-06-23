/**
 * Duplicate / overcharge detection from statement data (TASK 83).
 *
 * Extends statement reconciliation with two checks over the raw statement lines:
 *   - DUPLICATE charges: the same merchant charged the (near-)same amount within
 *     a short window — a likely double-billing.
 *   - OVERCHARGE / tip errors: the same merchant on the same day with two close
 *     amounts where one is modestly higher — a likely tip-entry mistake or a
 *     mis-keyed amount.
 *
 * Each pair is reported once. Pure / unit-testable — plain lines in, anomalies
 * out, no DB / network.
 */
import type { ChargeAnomaly } from '@/types';
import { merchantKey } from './recurringCharges';
import type { RawStatementLine } from './statementMatch';

interface Indexed extends RawStatementLine {
  index: number;
}

/** Whole-day gap between two ISO dates (Infinity if either missing). */
function dayGap(a: string | null, b: string | null): number {
  if (!a || !b) return Infinity;
  const ma = Date.parse(a);
  const mb = Date.parse(b);
  if (!Number.isFinite(ma) || !Number.isFinite(mb)) return Infinity;
  return Math.abs(Math.round((ma - mb) / 86400000));
}

/**
 * Detect duplicate + overcharge anomalies.
 *
 * @param duplicateWindowDays max day gap for two equal charges to count as a
 *        duplicate (default 3). Same-merchant equal amounts further apart are
 *        more likely a legitimate repeat purchase / subscription.
 * @param tipMaxRatio an overcharge pair must be within this fraction above the
 *        base amount to read as a tip/keying error (default 0.30 = up to +30%).
 */
export function detectChargeAnomalies(
  lines: RawStatementLine[],
  {
    duplicateWindowDays = 3,
    tipMaxRatio = 0.3,
  }: { duplicateWindowDays?: number; tipMaxRatio?: number } = {},
): ChargeAnomaly[] {
  const groups = new Map<string, Indexed[]>();
  lines.forEach((line, index) => {
    const key = merchantKey(line.description);
    if (!key) return;
    const list = groups.get(key) ?? [];
    list.push({ ...line, index });
    groups.set(key, list);
  });

  const out: ChargeAnomaly[] = [];

  for (const [key, items] of groups) {
    if (items.length < 2) continue;
    // Compare every unordered pair once.
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const gap = dayGap(a.date, b.date);
        const equal = Math.abs(a.amount - b.amount) < 0.01;

        if (equal) {
          // Duplicate: same amount, close in time (or undated, gap=Infinity is
          // excluded so we don't false-flag legit repeats spread over months).
          if (gap <= duplicateWindowDays && a.amount > 0) {
            out.push({
              kind: 'duplicate',
              merchant: key,
              lineIndexes: [a.index, b.index],
              amounts: [a.amount, b.amount],
              delta: round2(a.amount),
              reason: `Charged ${round2(a.amount)} twice within ${duplicateWindowDays} days`,
            });
          }
          continue;
        }

        // Overcharge / tip error: same merchant, same DAY, one amount modestly
        // higher than the other.
        if (gap === 0) {
          const lo = Math.min(a.amount, b.amount);
          const hi = Math.max(a.amount, b.amount);
          if (lo > 0) {
            const extra = hi - lo;
            const ratio = extra / lo;
            if (ratio > 0 && ratio <= tipMaxRatio) {
              out.push({
                kind: 'overcharge',
                merchant: key,
                lineIndexes: [a.index, b.index],
                amounts: [a.amount, b.amount],
                delta: round2(extra),
                reason: `Two same-day charges differ by ${round2(extra)} (possible tip or keying error)`,
              });
            }
          }
        }
      }
    }
  }

  return out;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
