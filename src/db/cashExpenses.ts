/** Cash expense DAO (V2 — manual entries so the expense record is complete). */
import { getDb, toInt } from './database';
import { mapCashExpense } from './mappers';
import { newId } from '../lib/id';
import type { CashExpense } from '../types';

const NOW = () => new Date().toISOString();

export async function listCashExpenses(): Promise<CashExpense[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM cash_expenses ORDER BY date DESC',
  );
  return rows.map(mapCashExpense);
}

export async function createCashExpense(
  input: Partial<CashExpense>,
): Promise<CashExpense> {
  const db = await getDb();
  const id = input.id ?? newId();
  await db.runAsync(
    `INSERT INTO cash_expenses (
      id, date, vendor, amount, currency, category_id, tax_category_id,
      payment_method_id, memo, is_deductible, deductible_percent, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.date ?? NOW().slice(0, 10),
      input.vendor ?? '',
      input.amount ?? 0,
      input.currency ?? 'USD',
      input.category_id ?? null,
      input.tax_category_id ?? null,
      input.payment_method_id ?? null,
      input.memo ?? '',
      toInt(input.is_deductible ?? false),
      input.deductible_percent ?? 100,
      input.created_at ?? NOW(),
    ],
  );
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM cash_expenses WHERE id = ?',
    [id],
  );
  return mapCashExpense(row);
}

export async function updateCashExpense(
  id: string,
  patch: Partial<CashExpense>,
): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const params: any[] = [];
  const cols = [
    'date',
    'vendor',
    'amount',
    'currency',
    'category_id',
    'tax_category_id',
    'payment_method_id',
    'memo',
    'deductible_percent',
  ] as const;
  for (const k of cols) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      params.push(patch[k] as any);
    }
  }
  if (patch.is_deductible !== undefined) {
    fields.push('is_deductible = ?');
    params.push(toInt(patch.is_deductible));
  }
  if (!fields.length) return;
  params.push(id);
  await db.runAsync(
    `UPDATE cash_expenses SET ${fields.join(', ')} WHERE id = ?`,
    params,
  );
}

export async function deleteCashExpense(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM cash_expenses WHERE id = ?', [id]);
}
