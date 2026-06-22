/** PaymentMethod DAO (user-editable in Settings). */
import { getDb, toInt } from './database';
import { mapPaymentMethod } from './mappers';
import { newId } from '../lib/id';
import type { PaymentMethod } from '../types';

export async function listPaymentMethods(): Promise<PaymentMethod[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM payment_methods ORDER BY sort_order ASC, name ASC',
  );
  return rows.map(mapPaymentMethod);
}

export async function createPaymentMethod(
  input: Partial<PaymentMethod>,
): Promise<PaymentMethod> {
  const db = await getDb();
  const id = input.id ?? newId();
  const order =
    input.sort_order ??
    ((
      await db.getFirstAsync<{ n: number }>(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM payment_methods',
      )
    )?.n ?? 0);
  await db.runAsync(
    'INSERT INTO payment_methods (id, name, is_default, sort_order) VALUES (?,?,?,?)',
    [id, input.name ?? 'New Method', toInt(input.is_default ?? false), order],
  );
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM payment_methods WHERE id = ?',
    [id],
  );
  return mapPaymentMethod(row);
}

export async function updatePaymentMethod(
  id: string,
  patch: Partial<PaymentMethod>,
): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const params: any[] = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    params.push(patch.name);
  }
  if (patch.sort_order !== undefined) {
    fields.push('sort_order = ?');
    params.push(patch.sort_order);
  }
  if (!fields.length) return;
  params.push(id);
  await db.runAsync(
    `UPDATE payment_methods SET ${fields.join(', ')} WHERE id = ?`,
    params,
  );
}

export async function deletePaymentMethod(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM payment_methods WHERE id = ?', [id]);
}
