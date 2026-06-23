/**
 * aiSummaryService — a one-line natural-language receipt summary (TASK 19).
 *
 * Opt-in and gated like every other cloud feature: it reuses the EXISTING
 * Gemini-backed proxy via the same device-authenticated `authedFetch` the
 * extraction client uses (no new backend). The proxy exposes a `/summarize`
 * endpoint that returns `{ summary: string }`. When the user hasn't opted in,
 * isn't unlocked, or the network is unavailable, this DEGRADES GRACEFULLY to a
 * local, fully on-device one-liner built from the receipt's own fields — so the
 * feature always produces something useful and never blocks or throws.
 *
 * Nothing is persisted server-side; the summary is computed on demand.
 */
import { appConfig } from '@/lib/config';
import { authedFetch } from '@/services/extractClient';
import { formatMoney } from '@/lib/money';
import type { ReceiptWithRelations } from '@/types';

/** Abort the (small) request fairly quickly; we'd rather fall back than hang. */
const SUMMARY_TIMEOUT_MS = 20000;

export interface SummaryResult {
  summary: string;
  /** 'ai' when the proxy produced it; 'local' when we fell back on-device. */
  source: 'ai' | 'local';
}

/**
 * Build a faithful, fully on-device one-liner from the receipt's own fields.
 * Used as the offline fallback AND when the cloud summary is disabled. Money is
 * always rendered through formatMoney (never a hand-built currency string).
 */
export function localSummary(receipt: ReceiptWithRelations): string {
  const vendor = receipt.vendor.trim() || 'a vendor';
  const amount = formatMoney(receipt.total, receipt.currency);
  const itemCount = receipt.line_items.filter((li) => li.included).length;
  const itemsPart =
    itemCount > 0 ? ` across ${itemCount} item${itemCount === 1 ? '' : 's'}` : '';
  const datePart = receipt.date ? ` on ${receipt.date}` : '';
  return `Spent ${amount} at ${vendor}${itemsPart}${datePart}.`;
}

/** Compact, privacy-conscious payload describing the receipt for the model. */
function summaryPayload(receipt: ReceiptWithRelations): Record<string, unknown> {
  return {
    vendor: receipt.vendor,
    date: receipt.date,
    total: receipt.total,
    currency: receipt.currency,
    items: receipt.line_items
      .filter((li) => li.included)
      .slice(0, 50)
      .map((li) => ({ name: li.name, qty: li.qty, price: li.price })),
    memo: receipt.memo || undefined,
  };
}

/**
 * Produce a one-line summary for a receipt.
 *
 * Always resolves (never rejects). When `enabled` is false we return the local
 * summary immediately. Otherwise we call the existing proxy's `/summarize`
 * endpoint via authedFetch and, on ANY failure (offline, timeout, 4xx/5xx, bad
 * body), fall back to `localSummary` so the user always gets a result.
 */
export async function summarizeReceipt(
  receipt: ReceiptWithRelations,
  opts: { enabled: boolean },
): Promise<SummaryResult> {
  if (!opts.enabled) {
    return { summary: localSummary(receipt), source: 'local' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const response = await authedFetch(`${appConfig.apiBaseUrl}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt: summaryPayload(receipt) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (__DEV__) console.warn(`[aiSummary] HTTP ${response.status}; using local fallback`);
      return { summary: localSummary(receipt), source: 'local' };
    }
    const json = (await response.json()) as { summary?: unknown };
    const summary = typeof json.summary === 'string' ? json.summary.trim() : '';
    if (!summary) return { summary: localSummary(receipt), source: 'local' };
    return { summary, source: 'ai' };
  } catch (err) {
    if (__DEV__) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[aiSummary] network error (${reason}); using local fallback`);
    }
    return { summary: localSummary(receipt), source: 'local' };
  } finally {
    clearTimeout(timer);
  }
}
