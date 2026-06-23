/**
 * Product-recall matching helpers (TASK 78) — pure / unit-testable.
 *
 * The recall SERVICE fetches the free CPSC recall feed and caches it; this
 * module holds the pure pieces: building the query URL, parsing the CPSC JSON
 * into our compact RecallRecord, and matching purchased item names against a
 * cached recall's product text. No DB, no network, no RN deps.
 *
 * Matching is deliberately conservative: we tokenize the purchased item name,
 * drop generic stop-words, and require a multi-character significant token to
 * appear in the recall's product text. This keeps it "best-effort" — good
 * enough to nudge, without flooding the user with false positives from common
 * words like "the" or "set".
 */
import type { RecallRecord } from '@/types';

const CPSC_BASE = 'https://www.saferproducts.gov/RestWebServices/Recall';

/**
 * Build a CPSC recall query URL. We query by RecallTitle keyword when a term is
 * given (cheap server-side narrowing); otherwise we fetch the most recent feed
 * window. Always JSON.
 */
export function buildRecallUrl(opts?: { title?: string; startDate?: string }): string {
  const params = new URLSearchParams({ format: 'json' });
  if (opts?.title) params.set('RecallTitle', opts.title);
  if (opts?.startDate) params.set('RecallDateStart', opts.startDate);
  return `${CPSC_BASE}?${params.toString()}`;
}

/** Strip a CPSC datetime ("2026-06-04T00:00:00") down to an ISO date. */
function isoDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Parse the raw CPSC JSON (an array of recall objects) into compact
 * RecallRecords. Tolerant of missing fields and non-array input — returns [].
 */
export function parseRecalls(json: unknown, cachedAt: string): RecallRecord[] {
  if (!Array.isArray(json)) return [];
  const out: RecallRecord[] = [];
  for (const r of json as any[]) {
    const recallId = String(r?.RecallID ?? r?.RecallNumber ?? '').trim();
    if (!recallId) continue;
    const products = Array.isArray(r?.Products) ? r.Products : [];
    const productText = products
      .map((p: any) => `${p?.Name ?? ''} ${p?.Description ?? ''} ${p?.Model ?? ''}`)
      .join(' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const hazards = Array.isArray(r?.Hazards) ? r.Hazards : [];
    const hazard = hazards.map((h: any) => h?.Name ?? '').filter(Boolean).join('; ');
    out.push({
      recall_id: recallId,
      title: String(r?.Title ?? '').trim(),
      recall_date: isoDate(r?.RecallDate),
      url: String(r?.URL ?? '').trim(),
      hazard,
      product_text: productText || String(r?.Title ?? '').toLowerCase(),
      cached_at: cachedAt,
    });
  }
  return out;
}

/** Generic words that must never, alone, trigger a recall match. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'set', 'pack', 'kit', 'new', 'pro', 'plus',
  'mini', 'max', 'size', 'large', 'small', 'medium', 'black', 'white', 'red',
  'blue', 'green', 'item', 'unit', 'pcs', 'piece', 'pieces', 'box', 'bag',
  'count', 'oz', 'lb', 'inch', 'cm', 'ml', 'each', 'qty', 'per', 'one', 'two',
]);

/**
 * Tokenize a purchased item name into significant lower-cased terms (length >= 4,
 * not a stop-word, not purely numeric).
 */
export function significantTerms(name: string): string[] {
  return Array.from(
    new Set(
      (name || '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)),
    ),
  );
}

/**
 * True when `itemName` plausibly refers to the same product as `recall`. Returns
 * the matched term so the caller can show why it matched, or null for no match.
 */
export function matchRecall(itemName: string, recall: RecallRecord): string | null {
  const text = recall.product_text;
  if (!text) return null;
  for (const term of significantTerms(itemName)) {
    // Word-boundary-ish containment to avoid "pan" matching "japan".
    const re = new RegExp(`(^|[^a-z])${escapeRe(term)}([^a-z]|$)`);
    if (re.test(text)) return term;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
