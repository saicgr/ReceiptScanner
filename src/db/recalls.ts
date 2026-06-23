/**
 * Recall cache DAO (TASK 78) — local cache of CPSC recall records so recall
 * checks work offline and don't re-fetch on every view, plus per-receipt
 * dismissals so a user can permanently silence a recall match.
 */
import { getDb } from './database';
import { mapRecallRecord } from './mappers';
import type { RecallRecord } from '../types';

const NOW = () => new Date().toISOString();

/** Upsert a batch of recall records into the cache (idempotent on recall_id). */
export async function cacheRecalls(records: RecallRecord[]): Promise<void> {
  if (!records.length) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const r of records) {
      await db.runAsync(
        `INSERT OR REPLACE INTO recall_cache
           (recall_id, title, recall_date, url, hazard, product_text, cached_at)
         VALUES (?,?,?,?,?,?,?)`,
        [r.recall_id, r.title, r.recall_date, r.url, r.hazard, r.product_text, r.cached_at],
      );
    }
  });
}

export async function listCachedRecalls(): Promise<RecallRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM recall_cache ORDER BY recall_date DESC',
  );
  return rows.map(mapRecallRecord);
}

/** ISO timestamp of the most recent cache write, or null when empty. */
export async function lastCachedAt(): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ ts: string | null }>(
    'SELECT MAX(cached_at) AS ts FROM recall_cache',
  );
  return row?.ts ?? null;
}

export async function countCachedRecalls(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM recall_cache',
  );
  return row?.n ?? 0;
}

/** Record that the user dismissed a recall match for a given receipt. */
export async function dismissRecall(receiptId: string, recallId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO recall_dismissals (receipt_id, recall_id, created_at)
     VALUES (?,?,?)`,
    [receiptId, recallId, NOW()],
  );
}

/** Set of "<receiptId>:<recallId>" keys the user has dismissed. */
export async function listDismissed(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ receipt_id: string; recall_id: string }>(
    'SELECT receipt_id, recall_id FROM recall_dismissals',
  );
  return new Set(rows.map((r) => `${r.receipt_id}:${r.recall_id}`));
}
