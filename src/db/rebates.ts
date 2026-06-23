/**
 * Rebate DAO (TASK 81) — mail-in rebate tracking. CRUD over the `rebates` table.
 * Reminders are scheduled by rebateService using the existing notification infra;
 * this layer is pure persistence.
 */
import { getDb } from './database';
import { mapRebate } from './mappers';
import { newId } from '../lib/id';
import type { Rebate } from '../types';

const NOW = () => new Date().toISOString();

export async function listRebates(): Promise<Rebate[]> {
  const db = await getDb();
  // Soonest submission deadline first; nulls last.
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM rebates
      ORDER BY (submission_deadline IS NULL), submission_deadline ASC, created_at DESC`,
  );
  return rows.map(mapRebate);
}

export async function getRebate(id: string): Promise<Rebate | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>('SELECT * FROM rebates WHERE id = ?', [id]);
  return row ? mapRebate(row) : null;
}

export async function listRebatesForReceipt(receiptId: string): Promise<Rebate[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM rebates WHERE receipt_id = ? ORDER BY created_at DESC',
    [receiptId],
  );
  return rows.map(mapRebate);
}

export async function createRebate(input: Partial<Rebate>): Promise<Rebate> {
  const db = await getDb();
  const id = input.id ?? newId();
  const now = NOW();
  await db.runAsync(
    `INSERT INTO rebates (
       id, receipt_id, vendor, description, amount, currency,
       submission_deadline, payout_deadline, status, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.receipt_id ?? null,
      input.vendor ?? '',
      input.description ?? '',
      input.amount ?? 0,
      input.currency ?? 'USD',
      input.submission_deadline ?? null,
      input.payout_deadline ?? null,
      input.status ?? 'pending',
      input.created_at ?? now,
      now,
    ],
  );
  return (await getRebate(id))!;
}

export async function updateRebate(id: string, patch: Partial<Rebate>): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const params: any[] = [];
  const cols = [
    'receipt_id',
    'vendor',
    'description',
    'amount',
    'currency',
    'submission_deadline',
    'payout_deadline',
    'status',
  ] as const;
  for (const k of cols) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      params.push(patch[k] as any);
    }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?');
  params.push(NOW());
  params.push(id);
  await db.runAsync(`UPDATE rebates SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function deleteRebate(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM rebates WHERE id = ?', [id]);
}
