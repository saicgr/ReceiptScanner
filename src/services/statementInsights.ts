/**
 * statementInsights (TASKS 82, 83, 85) — higher-level analysis layered on top of
 * the imported statement lines and the existing reconciliation.
 *
 *   - 82 Recurring/subscription detection: groups repeating same-amount/same-
 *        merchant charges (detectRecurringCharges).
 *   - 83 Duplicate / overcharge detection: flags likely double charges and tip
 *        errors (detectChargeAnomalies).
 *   - 85 Missing receipt / missing deduction nudges: turns UNMATCHED statement
 *        charges into "possible lost deduction" prompts.
 *
 * Pure detectors live in src/lib; this service just adapts the persisted
 * StatementLine[] (which carry their match state) into the lib's RawStatementLine
 * shape and assembles the results for the screen. No network, no new storage.
 */
import { detectRecurringCharges } from '@/lib/recurringCharges';
import { detectChargeAnomalies } from '@/lib/overcharge';
import type { RawStatementLine } from '@/lib/statementMatch';
import type {
  ChargeAnomaly,
  RecurringCharge,
  StatementLine,
} from '@/types';

/** A single unmatched charge reframed as a possible lost deduction (TASK 85). */
export interface MissingDeductionNudge {
  lineId: string;
  description: string;
  amount: number;
  date: string | null;
}

export interface StatementInsights {
  recurring: RecurringCharge[];
  anomalies: ChargeAnomaly[];
  missingDeductions: MissingDeductionNudge[];
}

/** Adapt persisted lines into the pure detectors' input (preserving order). */
function toRaw(lines: StatementLine[]): RawStatementLine[] {
  return lines.map((l) => ({
    date: l.date,
    amount: l.amount,
    description: l.description,
  }));
}

/**
 * Build all statement insights from the persisted lines of one import. The
 * recurring/anomaly detectors run over every line; the missing-deduction nudges
 * are derived from the lines that have no matched receipt.
 */
export function buildStatementInsights(lines: StatementLine[]): StatementInsights {
  const raw = toRaw(lines);

  const recurring = detectRecurringCharges(raw);
  const anomalies = detectChargeAnomalies(raw);

  const missingDeductions: MissingDeductionNudge[] = lines
    .filter((l) => !l.matched_receipt_id && l.amount > 0)
    .map((l) => ({
      lineId: l.id,
      description: l.description || 'Charge',
      amount: l.amount,
      date: l.date,
    }));

  return { recurring, anomalies, missingDeductions };
}
