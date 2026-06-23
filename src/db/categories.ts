/** Category + TaxCategory DAOs (user-editable in Settings). */
import { getDb, toInt } from './database';
import { mapCategory, mapTaxCategory } from './mappers';
import { newId } from '../lib/id';
import type { Category, TaxCategory } from '../types';

export async function listCategories(): Promise<Category[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM categories ORDER BY sort_order ASC, name ASC',
  );
  return rows.map(mapCategory);
}

export async function createCategory(
  input: Partial<Category>,
): Promise<Category> {
  const db = await getDb();
  const id = input.id ?? newId();
  const order =
    input.sort_order ??
    ((
      await db.getFirstAsync<{ n: number }>(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM categories',
      )
    )?.n ?? 0);
  await db.runAsync(
    'INSERT INTO categories (id, name, color, icon, is_default, sort_order, parent_id) VALUES (?,?,?,?,?,?,?)',
    [
      id,
      input.name ?? 'New Category',
      input.color ?? '#0E7C66',
      input.icon ?? 'tag',
      toInt(input.is_default ?? false),
      order,
      input.parent_id ?? null,
    ],
  );
  return (await getCategory(id))!;
}

export async function getCategory(id: string): Promise<Category | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM categories WHERE id = ?',
    [id],
  );
  return row ? mapCategory(row) : null;
}

export async function updateCategory(
  id: string,
  patch: Partial<Category>,
): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const params: any[] = [];
  for (const k of ['name', 'color', 'icon', 'sort_order', 'parent_id'] as const) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      params.push(patch[k]);
    }
  }
  if (!fields.length) return;
  params.push(id);
  await db.runAsync(
    `UPDATE categories SET ${fields.join(', ')} WHERE id = ?`,
    params,
  );
}

export async function deleteCategory(id: string): Promise<void> {
  const db = await getDb();
  // FK ON DELETE SET NULL keeps receipts intact, just uncategorized.
  await db.runAsync('DELETE FROM categories WHERE id = ?', [id]);
}

// --- Tax categories ---

export async function listTaxCategories(): Promise<TaxCategory[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM tax_categories ORDER BY name ASC',
  );
  return rows.map(mapTaxCategory);
}

export async function createTaxCategory(
  input: Partial<TaxCategory>,
): Promise<TaxCategory> {
  const db = await getDb();
  const id = input.id ?? newId();
  await db.runAsync(
    'INSERT INTO tax_categories (id, name, deductible_percent, schedule_c_line, is_default) VALUES (?,?,?,?,?)',
    [
      id,
      input.name ?? 'New Tax Category',
      input.deductible_percent ?? 100,
      input.schedule_c_line ?? null,
      toInt(input.is_default ?? false),
    ],
  );
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM tax_categories WHERE id = ?',
    [id],
  );
  return mapTaxCategory(row);
}

export async function updateTaxCategory(
  id: string,
  patch: Partial<TaxCategory>,
): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const params: any[] = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    params.push(patch.name);
  }
  if (patch.deductible_percent !== undefined) {
    fields.push('deductible_percent = ?');
    params.push(patch.deductible_percent);
  }
  if (patch.schedule_c_line !== undefined) {
    fields.push('schedule_c_line = ?');
    params.push(patch.schedule_c_line);
  }
  if (!fields.length) return;
  params.push(id);
  await db.runAsync(
    `UPDATE tax_categories SET ${fields.join(', ')} WHERE id = ?`,
    params,
  );
}

export async function deleteTaxCategory(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM tax_categories WHERE id = ?', [id]);
}

export async function getTaxCategory(id: string): Promise<TaxCategory | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM tax_categories WHERE id = ?',
    [id],
  );
  return row ? mapTaxCategory(row) : null;
}
