/**
 * recallService (TASK 78) — product-recall alerts.
 *
 * Matches purchased item names against the FREE public CPSC recall feed
 * (https://www.saferproducts.gov/RestWebServices/Recall). Strictly best-effort
 * and on-device:
 *   - `refreshRecalls()` fetches a recent window of the feed and CACHES it
 *     locally (recall_cache). On any network failure (offline, timeout, 5xx) it
 *     degrades gracefully — the cached records remain usable.
 *   - `findMatches()` matches the user's receipt line-item names against the
 *     cached records using the pure matcher in lib/recall, honouring the user's
 *     dismissals. Works fully offline once the cache is warm.
 *   - `notifyMatches()` fires a single local notification summarizing new
 *     matches, reusing the notification infra.
 *
 * No server, no storage of user data anywhere but the local SQLite cache.
 */
import * as DB from '@/db';
import { matchRecall, buildRecallUrl, parseRecalls } from '@/lib/recall';
import type { RecallMatch } from '@/types';
import { ensurePermissions, scheduleDeadlineReminders } from './notificationsService';

/** Abort the network fetch if the feed is slow — recalls are non-critical. */
const REQUEST_TIMEOUT_MS = 10000;

/** Cache TTL: skip a network refresh if we fetched within this window. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

export interface RefreshResult {
  online: boolean;
  cachedCount: number;
}

/** ISO date `days` before today, for narrowing the CPSC feed window. */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Refresh the local recall cache from the CPSC feed. Best-effort: returns
 * `online:false` (with the existing cache count) on any failure. Pass
 * `force:true` to bypass the TTL.
 */
export async function refreshRecalls(opts?: { force?: boolean }): Promise<RefreshResult> {
  // Respect the TTL unless forced.
  if (!opts?.force) {
    try {
      const last = await DB.Recalls.lastCachedAt();
      if (last && Date.now() - Date.parse(last) < CACHE_TTL_MS) {
        return { online: true, cachedCount: await DB.Recalls.countCachedRecalls() };
      }
    } catch {
      // Cache check failed — fall through and try a fetch anyway.
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // Recent window keeps the payload small (best-effort, not exhaustive).
    const url = buildRecallUrl({ startDate: isoDaysAgo(365) });
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) throw new Error(`recall feed HTTP ${res.status}`);
    const json = (await res.json()) as unknown;
    const records = parseRecalls(json, new Date().toISOString());
    if (records.length > 0) {
      await DB.Recalls.cacheRecalls(records);
    }
    return { online: true, cachedCount: await DB.Recalls.countCachedRecalls() };
  } catch (err) {
    if (__DEV__) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[recallService] refresh failed (${reason}); using cache`);
    }
    let cachedCount = 0;
    try {
      cachedCount = await DB.Recalls.countCachedRecalls();
    } catch {
      /* cache unavailable */
    }
    return { online: false, cachedCount };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find recall matches across ALL receipts' line items against the cached feed.
 * Honours per-receipt dismissals. Read-only; returns [] on any error.
 */
export async function findMatches(): Promise<RecallMatch[]> {
  try {
    const [recalls, dismissed] = await Promise.all([
      DB.Recalls.listCachedRecalls(),
      DB.Recalls.listDismissed(),
    ]);
    if (recalls.length === 0) return [];

    const receipts = await DB.listReceiptsWithRelations({});
    const matches: RecallMatch[] = [];
    const seen = new Set<string>(); // dedupe receipt+recall pairs

    for (const r of receipts) {
      // Match against each line item name (and the vendor as a fallback term).
      const candidates: { name: string; lineItemId: string | null }[] =
        r.line_items.length > 0
          ? r.line_items.map((li) => ({ name: li.name, lineItemId: li.id }))
          : [{ name: r.vendor, lineItemId: null }];

      for (const recall of recalls) {
        const pairKey = `${r.id}:${recall.recall_id}`;
        if (seen.has(pairKey)) continue;
        if (dismissed.has(pairKey)) continue;
        for (const c of candidates) {
          const term = matchRecall(c.name, recall);
          if (term) {
            matches.push({
              recall,
              matchedTerm: term,
              receiptId: r.id,
              lineItemId: c.lineItemId,
            });
            seen.add(pairKey);
            break; // one match per receipt+recall pair is enough
          }
        }
      }
    }
    return matches;
  } catch (err) {
    if (__DEV__) console.warn('[recallService] findMatches failed', err);
    return [];
  }
}

/** Find recall matches for a SINGLE receipt (used by the receipt detail). */
export async function findMatchesForReceipt(receiptId: string): Promise<RecallMatch[]> {
  const all = await findMatches();
  return all.filter((m) => m.receiptId === receiptId);
}

export async function dismissMatch(receiptId: string, recallId: string): Promise<void> {
  await DB.Recalls.dismissRecall(receiptId, recallId);
}

/**
 * Fire a single local notification summarizing recall matches (best-effort). We
 * reuse the generic deadline scheduler with a near-immediate trigger so it goes
 * through the same code path; if permission is denied it simply no-ops.
 */
export async function notifyMatches(matches: RecallMatch[]): Promise<void> {
  if (matches.length === 0) return;
  try {
    const granted = await ensurePermissions();
    if (!granted) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const deadline = tomorrow.toISOString().slice(0, 10);
    const first = matches[0];
    await scheduleDeadlineReminders('recall-notif', [
      {
        // daysBefore=0 fires on the trigger day (tomorrow morning).
        deadline,
        daysBefore: 0,
        title: 'Possible product recall',
        body:
          matches.length === 1
            ? `“${first.recall.title}” may match a product you bought. Tap to review.`
            : `${matches.length} of your purchases may match active product recalls.`,
        data: { kind: 'recall' },
      },
    ]);
  } catch {
    // best-effort
  }
}
