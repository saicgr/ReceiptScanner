/**
 * Price-protection DAO (TASK 79) — price-drop / price-protection claim tracking.
 * CRUD over `price_protections`. Reminders scheduled by priceProtectionService.
 */
import { getDb } from './database';
import { mapPriceProtection } from './mappers';
import { newId } from '../lib/id';
import type { PriceProtection } from '../types';

const NOW = () => new Date().toISOString();

export async function listPriceProtections(): Promise<PriceProtection[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM price_protections
      ORDER BY (claim_deadline IS NULL), claim_deadline ASC, created_at DESC`,
  );
  return rows.map(mapPriceProtection);
}

export async function getPriceProtection(id: string): Promise<PriceProtection | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM price_protections WHERE id = ?',
    [id],
  );
  return row ? mapPriceProtection(row) : null;
}

export async function listPriceProtectionsForReceipt(
  receiptId: string,
): Promise<PriceProtection[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM price_protections WHERE receipt_id = ? ORDER BY created_at DESC',
    [receiptId],
  );
  return rows.map(mapPriceProtection);
}

export async function createPriceProtection(
  input: Partial<PriceProtection>,
): Promise<PriceProtection> {
  const db = await getDb();
  const id = input.id ?? newId();
  const now = NOW();
  await db.runAsync(
    `INSERT INTO price_protections (
       id, receipt_id, vendor, item_name, currency,
       original_price, current_price, claim_deadline, status, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.receipt_id ?? null,
      input.vendor ?? '',
      input.item_name ?? '',
      input.currency ?? 'USD',
      input.original_price ?? 0,
      input.current_price ?? 0,
      input.claim_deadline ?? null,
      input.status ?? 'open',
      input.created_at ?? now,
      now,
    ],
  );
  return (await getPriceProtection(id))!;
}

export async function updatePriceProtection(
  id: string,
  patch: Partial<PriceProtection>,
): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const params: any[] = [];
  const cols = [
    'receipt_id',
    'vendor',
    'item_name',
    'currency',
    'original_price',
    'current_price',
    'claim_deadline',
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
  await db.runAsync(
    `UPDATE price_protections SET ${fields.join(', ')} WHERE id = ?`,
    params,
  );
}

export async function deletePriceProtection(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM price_protections WHERE id = ?', [id]);
}
