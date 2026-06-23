/**
 * Revisions + audit-log DAO — lightweight receipt versioning.
 *
 * Two complementary records keep edits transparent and reversible:
 *  - receipt_revisions: full point-in-time SNAPSHOTS. The first, captured at
 *    create time, has kind='original' and is NEVER overwritten — it preserves
 *    the AI's original extraction so the user can always revert to it.
 *  - receipt_audit_log: a field-level CHANGE LOG (before/after) shown as a
 *    human-readable edit history.
 */
import { getDb } from './database';
import { mapReceiptRevision, mapAuditLogEntry } from './mappers';
import { newId } from '../lib/id';
import type {
  AuditLogEntry,
  ReceiptRevision,
  RevisionKind,
  RevisionSnapshot,
} from '../types';

const NOW = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/**
 * Save a snapshot. For kind='original' this is a no-op if one already exists,
 * so the immutable original extraction is captured exactly once.
 */
export async function saveRevision(
  receiptId: string,
  kind: RevisionKind,
  snapshot: RevisionSnapshot,
): Promise<void> {
  const db = await getDb();
  if (kind === 'original') {
    const existing = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) as n FROM receipt_revisions WHERE receipt_id = ? AND kind = 'original'",
      [receiptId],
    );
    if ((existing?.n ?? 0) > 0) return;
  }
  await db.runAsync(
    'INSERT INTO receipt_revisions (id, receipt_id, kind, snapshot_json, created_at) VALUES (?,?,?,?,?)',
    [newId(), receiptId, kind, JSON.stringify(snapshot), NOW()],
  );
}

export async function listRevisions(
  receiptId: string,
): Promise<ReceiptRevision[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM receipt_revisions WHERE receipt_id = ? ORDER BY created_at DESC',
    [receiptId],
  );
  return rows.map(mapReceiptRevision);
}

/** The immutable original-extraction snapshot, if one was captured. */
export async function getOriginalRevision(
  receiptId: string,
): Promise<ReceiptRevision | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    "SELECT * FROM receipt_revisions WHERE receipt_id = ? AND kind = 'original' LIMIT 1",
    [receiptId],
  );
  return row ? mapReceiptRevision(row) : null;
}

/** Decode a revision's snapshot payload. */
export function decodeSnapshot(rev: ReceiptRevision): RevisionSnapshot | null {
  try {
    return JSON.parse(rev.snapshot_json) as RevisionSnapshot;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditChange {
  field: string;
  old: string | null;
  new: string | null;
}

/** Append a batch of field-level changes to the receipt's edit log. */
export async function logChanges(
  receiptId: string,
  changes: AuditChange[],
): Promise<void> {
  if (!changes.length) return;
  const db = await getDb();
  const now = NOW();
  await db.withTransactionAsync(async () => {
    for (const c of changes) {
      await db.runAsync(
        'INSERT INTO receipt_audit_log (id, receipt_id, field, old_value, new_value, created_at) VALUES (?,?,?,?,?,?)',
        [newId(), receiptId, c.field, c.old, c.new, now],
      );
    }
  });
}

export async function listAuditLog(
  receiptId: string,
): Promise<AuditLogEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM receipt_audit_log WHERE receipt_id = ? ORDER BY created_at DESC',
    [receiptId],
  );
  return rows.map(mapAuditLogEntry);
}
