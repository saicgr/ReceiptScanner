/**
 * Receipt DAO — create/read/update/delete receipts plus their line items, tags
 * and page images, and the aggregate queries that power History & Statistics.
 *
 * The "subtotal" stored on a receipt is always the sum of its *included* line
 * items; `recomputeTotals` keeps it in sync after any line-item edit, which is
 * how the review screen recalculates totals in real time when items are
 * deleted / unticked.
 */
import { getDb, toInt } from './database';
import {
  mapReceipt,
  mapLineItem,
  mapTag,
  mapReceiptImage,
} from './mappers';
import { newId } from '../lib/id';
import type {
  Receipt,
  ReceiptWithRelations,
  LineItem,
  ExportFilter,
  CurrencyTotal,
  CategorySpend,
  MonthlySpend,
} from '../types';

const NOW = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type NewReceiptInput = Partial<Receipt> & {
  line_items?: Partial<LineItem>[];
  image_uris?: string[];
  tag_ids?: string[];
};

export async function createReceipt(
  input: NewReceiptInput,
): Promise<ReceiptWithRelations> {
  const db = await getDb();
  const id = input.id ?? newId();
  const now = NOW();

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO receipts (
        id, vendor, account_label, account_last4,
        date, date_confidence, date_ambiguous, date_options,
        total, tax, subtotal, currency, category_id, payment_method_id, memo,
        original_image_uri, saved_filename, image_format, source, status,
        content_hash, duplicate_of, field_confidence,
        return_window_days, warranty_period_days, return_deadline, warranty_deadline,
        protection_status, tax_category_id, is_deductible, deductible_percent,
        condition_tags, captured_at, captured_lat, captured_lng,
        created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.vendor ?? '',
        input.account_label ?? null,
        input.account_last4 ?? null,
        input.date ?? null,
        input.date_confidence ?? 'low',
        toInt(input.date_ambiguous ?? false),
        JSON.stringify(input.date_options ?? []),
        input.total ?? 0,
        input.tax ?? null,
        input.subtotal ?? 0,
        input.currency ?? 'USD',
        input.category_id ?? null,
        input.payment_method_id ?? null,
        input.memo ?? '',
        input.original_image_uri ?? null,
        input.saved_filename ?? null,
        input.image_format ?? 'jpg',
        input.source ?? 'camera',
        input.status ?? 'pending',
        input.content_hash ?? null,
        input.duplicate_of ?? null,
        JSON.stringify(input.field_confidence ?? {}),
        input.return_window_days ?? null,
        input.warranty_period_days ?? null,
        input.return_deadline ?? null,
        input.warranty_deadline ?? null,
        input.protection_status ?? 'none',
        input.tax_category_id ?? null,
        toInt(input.is_deductible ?? false),
        input.deductible_percent ?? 100,
        JSON.stringify(input.condition_tags ?? []),
        input.captured_at ?? null,
        input.captured_lat ?? null,
        input.captured_lng ?? null,
        now,
        now,
      ],
    );

    let order = 0;
    for (const li of input.line_items ?? []) {
      await insertLineItem(db, id, li, order++);
    }
    order = 0;
    for (const uri of input.image_uris ?? []) {
      await db.runAsync(
        'INSERT INTO receipt_images (id, receipt_id, uri, page_order) VALUES (?,?,?,?)',
        [newId(), id, uri, order++],
      );
    }
    for (const tagId of input.tag_ids ?? []) {
      await db.runAsync(
        'INSERT OR IGNORE INTO receipt_tags (receipt_id, tag_id) VALUES (?,?)',
        [id, tagId],
      );
    }
  });

  await recomputeTotals(id);
  const out = await getReceipt(id);
  if (!out) throw new Error('Failed to create receipt');
  return out;
}

async function insertLineItem(
  db: Awaited<ReturnType<typeof getDb>>,
  receiptId: string,
  li: Partial<LineItem>,
  order: number,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO line_items (
      id, receipt_id, name, qty, price, included, category_id, sort_order,
      protection_status, return_window_days, warranty_period_days,
      return_deadline, warranty_deadline, serial_number, product_photo_uri
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      li.id ?? newId(),
      receiptId,
      li.name ?? '',
      li.qty ?? 1,
      li.price ?? 0,
      toInt(li.included ?? true),
      li.category_id ?? null,
      li.sort_order ?? order,
      li.protection_status ?? 'none',
      li.return_window_days ?? null,
      li.warranty_period_days ?? null,
      li.return_deadline ?? null,
      li.warranty_deadline ?? null,
      li.serial_number ?? null,
      li.product_photo_uri ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getReceipt(
  id: string,
): Promise<ReceiptWithRelations | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM receipts WHERE id = ?',
    [id],
  );
  if (!row) return null;
  const receipt = mapReceipt(row);

  const liRows = await db.getAllAsync<any>(
    'SELECT * FROM line_items WHERE receipt_id = ? ORDER BY sort_order ASC',
    [id],
  );
  const imgRows = await db.getAllAsync<any>(
    'SELECT * FROM receipt_images WHERE receipt_id = ? ORDER BY page_order ASC',
    [id],
  );
  const tagRows = await db.getAllAsync<any>(
    `SELECT t.* FROM tags t
     JOIN receipt_tags rt ON rt.tag_id = t.id
     WHERE rt.receipt_id = ? ORDER BY t.name ASC`,
    [id],
  );

  return {
    ...receipt,
    line_items: liRows.map(mapLineItem),
    images: imgRows.map(mapReceiptImage),
    tags: tagRows.map(mapTag),
  };
}

export interface ListReceiptsOptions extends ExportFilter {
  status?: 'pending' | 'finalized' | 'all';
  search?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'date_desc' | 'date_asc' | 'created_desc' | 'amount_desc';
}

export async function listReceipts(
  opts: ListReceiptsOptions = {},
): Promise<Receipt[]> {
  const db = await getDb();
  const where: string[] = [];
  const params: any[] = [];

  if (opts.status && opts.status !== 'all') {
    where.push('r.status = ?');
    params.push(opts.status);
  }
  if (opts.startDate) {
    where.push('r.date >= ?');
    params.push(opts.startDate);
  }
  if (opts.endDate) {
    where.push('r.date <= ?');
    params.push(opts.endDate);
  }
  if (opts.currency) {
    where.push('r.currency = ?');
    params.push(opts.currency);
  }
  if (opts.categoryIds && opts.categoryIds.length) {
    where.push(
      `r.category_id IN (${opts.categoryIds.map(() => '?').join(',')})`,
    );
    params.push(...opts.categoryIds);
  }
  if (opts.search) {
    where.push('(r.vendor LIKE ? OR r.memo LIKE ?)');
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  if (opts.tagIds && opts.tagIds.length) {
    where.push(
      `r.id IN (SELECT receipt_id FROM receipt_tags WHERE tag_id IN (${opts.tagIds
        .map(() => '?')
        .join(',')}))`,
    );
    params.push(...opts.tagIds);
  }

  const order =
    opts.orderBy === 'date_asc'
      ? 'r.date ASC'
      : opts.orderBy === 'created_desc'
        ? 'r.created_at DESC'
        : opts.orderBy === 'amount_desc'
          ? 'r.total DESC'
          : 'r.date DESC, r.created_at DESC';

  const sql =
    `SELECT r.* FROM receipts r` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${order}` +
    (opts.limit ? ` LIMIT ${opts.limit}` : '') +
    (opts.offset ? ` OFFSET ${opts.offset}` : '');

  const rows = await db.getAllAsync<any>(sql, params);
  return rows.map(mapReceipt);
}

/** Loads multiple receipts WITH relations (used by itemized exports). */
export async function listReceiptsWithRelations(
  opts: ListReceiptsOptions = {},
): Promise<ReceiptWithRelations[]> {
  const base = await listReceipts(opts);
  const out: ReceiptWithRelations[] = [];
  for (const r of base) {
    const full = await getReceipt(r.id);
    if (full) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

const RECEIPT_COLUMNS = new Set([
  'vendor',
  'account_label',
  'account_last4',
  'date',
  'date_confidence',
  'date_ambiguous',
  'date_options',
  'total',
  'tax',
  'subtotal',
  'currency',
  'category_id',
  'payment_method_id',
  'memo',
  'original_image_uri',
  'saved_filename',
  'image_format',
  'source',
  'status',
  'content_hash',
  'duplicate_of',
  'field_confidence',
  'return_window_days',
  'warranty_period_days',
  'return_deadline',
  'warranty_deadline',
  'protection_status',
  'tax_category_id',
  'is_deductible',
  'deductible_percent',
  'condition_tags',
  'captured_at',
  'captured_lat',
  'captured_lng',
]);

const JSON_COLUMNS = new Set(['date_options', 'field_confidence', 'condition_tags']);
const BOOL_COLUMNS = new Set(['date_ambiguous', 'is_deductible']);

export async function updateReceipt(
  id: string,
  patch: Partial<Receipt>,
): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const params: any[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (!RECEIPT_COLUMNS.has(key)) continue;
    sets.push(`${key} = ?`);
    if (JSON_COLUMNS.has(key)) params.push(JSON.stringify(value));
    else if (BOOL_COLUMNS.has(key)) params.push(toInt(Boolean(value)));
    else params.push(value as any);
  }
  if (!sets.length) return;

  sets.push('updated_at = ?');
  params.push(NOW());
  params.push(id);

  await db.runAsync(
    `UPDATE receipts SET ${sets.join(', ')} WHERE id = ?`,
    params,
  );
}

/** Replace ALL line items for a receipt (review screen commits the full list). */
export async function replaceLineItems(
  receiptId: string,
  items: Partial<LineItem>[],
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM line_items WHERE receipt_id = ?', [
      receiptId,
    ]);
    let order = 0;
    for (const li of items) {
      await insertLineItem(db, receiptId, li, order++);
    }
  });
  await recomputeTotals(receiptId);
}

/**
 * Recomputes subtotal from included line items. If the receipt has line items
 * we also keep `total` honest: total = subtotal + tax (when tax is known). When
 * there are no line items we leave the user-entered total untouched.
 */
export async function recomputeTotals(receiptId: string): Promise<void> {
  const db = await getDb();
  const items = await db.getAllAsync<any>(
    'SELECT qty, price, included FROM line_items WHERE receipt_id = ?',
    [receiptId],
  );
  if (!items.length) return;

  const subtotal = items
    .filter((i) => i.included === 1)
    .reduce((sum, i) => sum + Number(i.qty) * Number(i.price), 0);

  const r = await db.getFirstAsync<{ tax: number | null }>(
    'SELECT tax FROM receipts WHERE id = ?',
    [receiptId],
  );
  const tax = r?.tax ?? 0;
  const total = round2(subtotal + Number(tax ?? 0));

  await db.runAsync(
    'UPDATE receipts SET subtotal = ?, total = ?, updated_at = ? WHERE id = ?',
    [round2(subtotal), total, NOW(), receiptId],
  );
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Tags on a receipt
// ---------------------------------------------------------------------------

export async function setReceiptTags(
  receiptId: string,
  tagIds: string[],
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM receipt_tags WHERE receipt_id = ?', [
      receiptId,
    ]);
    for (const tagId of tagIds) {
      await db.runAsync(
        'INSERT OR IGNORE INTO receipt_tags (receipt_id, tag_id) VALUES (?,?)',
        [receiptId, tagId],
      );
    }
  });
}

export async function setReceiptImages(
  receiptId: string,
  uris: string[],
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM receipt_images WHERE receipt_id = ?', [
      receiptId,
    ]);
    let order = 0;
    for (const uri of uris) {
      await db.runAsync(
        'INSERT INTO receipt_images (id, receipt_id, uri, page_order) VALUES (?,?,?,?)',
        [newId(), receiptId, uri, order++],
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteReceipt(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM receipts WHERE id = ?', [id]);
}

export async function deleteReceipts(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await getDb();
  await db.runAsync(
    `DELETE FROM receipts WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
}

// ---------------------------------------------------------------------------
// Duplicate detection support
// ---------------------------------------------------------------------------

/** Returns receipts whose content hash matches, or that look near-identical. */
export async function findPotentialDuplicates(
  hash: string | null,
  vendor: string,
  total: number,
  date: string | null,
  excludeId?: string,
): Promise<Receipt[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM receipts
     WHERE (content_hash = ? AND content_hash IS NOT NULL)
        OR (vendor = ? AND ABS(total - ?) < 0.01 AND date IS ? )
     ${excludeId ? 'AND id != ?' : ''}`,
    excludeId ? [hash, vendor, total, date, excludeId] : [hash, vendor, total, date],
  );
  return rows.map(mapReceipt);
}

// ---------------------------------------------------------------------------
// Aggregates for Statistics
// ---------------------------------------------------------------------------

export async function totalsByCurrency(
  filter: ExportFilter = {},
): Promise<CurrencyTotal[]> {
  const db = await getDb();
  const { whereSql, params } = buildStatWhere(filter);
  const rows = await db.getAllAsync<any>(
    `SELECT currency, SUM(total) as total, COUNT(*) as count
     FROM receipts r ${whereSql}
     GROUP BY currency ORDER BY total DESC`,
    params,
  );
  return rows.map((r) => ({
    currency: r.currency,
    total: Number(r.total ?? 0),
    count: Number(r.count ?? 0),
  }));
}

export async function spendByCategory(
  filter: ExportFilter = {},
): Promise<CategorySpend[]> {
  const db = await getDb();
  const { whereSql, params } = buildStatWhere(filter);
  const rows = await db.getAllAsync<any>(
    `SELECT r.category_id as categoryId,
            COALESCE(c.name, 'Uncategorized') as categoryName,
            COALESCE(c.color, '#64748B') as color,
            r.currency as currency,
            SUM(r.total) as total,
            COUNT(*) as count
     FROM receipts r
     LEFT JOIN categories c ON c.id = r.category_id
     ${whereSql}
     GROUP BY r.category_id, r.currency
     ORDER BY total DESC`,
    params,
  );
  return rows.map((r) => ({
    categoryId: r.categoryId ?? null,
    categoryName: r.categoryName,
    color: r.color,
    currency: r.currency,
    total: Number(r.total ?? 0),
    count: Number(r.count ?? 0),
  }));
}

export async function spendByMonth(
  filter: ExportFilter = {},
): Promise<MonthlySpend[]> {
  const db = await getDb();
  const { whereSql, params } = buildStatWhere(filter);
  const rows = await db.getAllAsync<any>(
    `SELECT substr(r.date, 1, 7) as month, r.currency as currency, SUM(r.total) as total
     FROM receipts r ${whereSql} ${whereSql ? 'AND' : 'WHERE'} r.date IS NOT NULL
     GROUP BY month, currency
     ORDER BY month ASC`,
    params,
  );
  return rows.map((r) => ({
    month: r.month,
    currency: r.currency,
    total: Number(r.total ?? 0),
  }));
}

/**
 * Spend grouped by individual calendar DAY (daily-pattern chart). Only dated,
 * finalized receipts are counted; grouped per currency so totals never mix.
 */
export async function spendByDay(
  filter: ExportFilter = {},
): Promise<import('../types').DailySpend[]> {
  const db = await getDb();
  const { whereSql, params } = buildStatWhere(filter);
  const rows = await db.getAllAsync<any>(
    `SELECT r.date as date, r.currency as currency, SUM(r.total) as total
     FROM receipts r ${whereSql} AND r.date IS NOT NULL
     GROUP BY r.date, currency
     ORDER BY r.date ASC`,
    params,
  );
  return rows.map((r) => ({
    date: r.date,
    currency: r.currency,
    total: Number(r.total ?? 0),
  }));
}

function buildStatWhere(filter: ExportFilter): {
  whereSql: string;
  params: any[];
} {
  const where: string[] = ["r.status = 'finalized'"];
  const params: any[] = [];
  if (filter.startDate) {
    where.push('r.date >= ?');
    params.push(filter.startDate);
  }
  if (filter.endDate) {
    where.push('r.date <= ?');
    params.push(filter.endDate);
  }
  if (filter.currency) {
    where.push('r.currency = ?');
    params.push(filter.currency);
  }
  if (filter.categoryIds && filter.categoryIds.length) {
    where.push(
      `r.category_id IN (${filter.categoryIds.map(() => '?').join(',')})`,
    );
    params.push(...filter.categoryIds);
  }
  if (filter.tagIds && filter.tagIds.length) {
    where.push(
      `r.id IN (SELECT receipt_id FROM receipt_tags WHERE tag_id IN (${filter.tagIds
        .map(() => '?')
        .join(',')}))`,
    );
    params.push(...filter.tagIds);
  }
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

/** Spend grouped by vendor/company (Statistics: "By Company"). */
export async function spendByCompany(
  filter: ExportFilter = {},
): Promise<import('../types').GroupedSpend[]> {
  const db = await getDb();
  const { whereSql, params } = buildStatWhere(filter);
  const rows = await db.getAllAsync<any>(
    `SELECT r.vendor as label, r.currency as currency, SUM(r.total) as total, COUNT(*) as count
     FROM receipts r ${whereSql} AND r.vendor != ''
     GROUP BY r.vendor, r.currency
     ORDER BY total DESC`,
    params,
  );
  return rows.map((r) => ({
    key: r.label,
    label: r.label || 'Unknown',
    color: '#64748B',
    currency: r.currency,
    total: Number(r.total ?? 0),
    count: Number(r.count ?? 0),
  }));
}

/** Spend grouped by payment method (Statistics: "By Payment Method"). */
export async function spendByPaymentMethod(
  filter: ExportFilter = {},
): Promise<import('../types').GroupedSpend[]> {
  const db = await getDb();
  const { whereSql, params } = buildStatWhere(filter);
  const rows = await db.getAllAsync<any>(
    `SELECT r.payment_method_id as key,
            COALESCE(p.name, 'Unspecified') as label,
            r.currency as currency, SUM(r.total) as total, COUNT(*) as count
     FROM receipts r
     LEFT JOIN payment_methods p ON p.id = r.payment_method_id
     ${whereSql}
     GROUP BY r.payment_method_id, r.currency
     ORDER BY total DESC`,
    params,
  );
  return rows.map((r) => ({
    key: r.key ?? null,
    label: r.label,
    color: '#2563EB',
    currency: r.currency,
    total: Number(r.total ?? 0),
    count: Number(r.count ?? 0),
  }));
}

/** Spend grouped by individual line item (Statistics: "By Item"). */
export async function spendByItem(
  filter: ExportFilter = {},
): Promise<import('../types').GroupedSpend[]> {
  const db = await getDb();
  const { whereSql, params } = buildStatWhere(filter);
  const rows = await db.getAllAsync<any>(
    `SELECT li.name as label, r.currency as currency,
            SUM(li.qty * li.price) as total, COUNT(*) as count
     FROM line_items li
     JOIN receipts r ON r.id = li.receipt_id
     ${whereSql} AND li.included = 1 AND li.name != ''
     GROUP BY LOWER(li.name), r.currency
     ORDER BY total DESC
     LIMIT 50`,
    params,
  );
  return rows.map((r) => ({
    key: r.label,
    label: r.label,
    color: '#13A085',
    currency: r.currency,
    total: Number(r.total ?? 0),
    count: Number(r.count ?? 0),
  }));
}

/**
 * Spend grouped by SUBCATEGORY (Statistics: "By Subcategory"). A receipt's
 * subcategory is its category when that category has a parent_id set; receipts
 * in a top-level category are bucketed as "(no subcategory)". Grouped per
 * currency so totals are never mixed.
 */
export async function spendBySubcategory(
  filter: ExportFilter = {},
): Promise<import('../types').GroupedSpend[]> {
  const db = await getDb();
  const { whereSql, params } = buildStatWhere(filter);
  const rows = await db.getAllAsync<any>(
    `SELECT c.id as key,
            COALESCE(c.name, '(no subcategory)') as label,
            COALESCE(c.color, '#94A3B8') as color,
            r.currency as currency,
            SUM(r.total) as total,
            COUNT(*) as count
     FROM receipts r
     LEFT JOIN categories c ON c.id = r.category_id AND c.parent_id IS NOT NULL
     ${whereSql}
     GROUP BY (CASE WHEN c.parent_id IS NOT NULL THEN c.id ELSE NULL END), r.currency
     ORDER BY total DESC`,
    params,
  );
  return rows.map((r) => ({
    key: r.key ?? null,
    label: r.key ? r.label : '(no subcategory)',
    color: r.key ? r.color : '#94A3B8',
    currency: r.currency,
    total: Number(r.total ?? 0),
    count: Number(r.count ?? 0),
  }));
}

/** Headline quick stats per currency (total, avg, highest, most frequent vendor). */
export async function quickStats(
  filter: ExportFilter = {},
): Promise<import('../types').QuickStats[]> {
  const db = await getDb();
  const { whereSql, params } = buildStatWhere(filter);
  const totals = await db.getAllAsync<any>(
    `SELECT currency, SUM(total) as total, COUNT(*) as count, AVG(total) as average
     FROM receipts r ${whereSql}
     GROUP BY currency ORDER BY total DESC`,
    params,
  );
  const out: import('../types').QuickStats[] = [];
  for (const t of totals) {
    const high = await db.getFirstAsync<any>(
      `SELECT id, vendor, total FROM receipts r ${whereSql} AND r.currency = ?
       ORDER BY total DESC LIMIT 1`,
      [...params, t.currency],
    );
    const freq = await db.getFirstAsync<any>(
      `SELECT vendor, COUNT(*) as count FROM receipts r ${whereSql} AND r.currency = ? AND r.vendor != ''
       GROUP BY vendor ORDER BY count DESC, total DESC LIMIT 1`,
      [...params, t.currency],
    );
    out.push({
      currency: t.currency,
      total: Number(t.total ?? 0),
      count: Number(t.count ?? 0),
      average: Number(t.average ?? 0),
      highest: high ? { receiptId: high.id, vendor: high.vendor, total: Number(high.total) } : null,
      mostFrequentVendor: freq ? { vendor: freq.vendor, count: Number(freq.count) } : null,
    });
  }
  return out;
}

/**
 * Distinct non-empty vendor names, most-recent first — the candidate pool for
 * vendor autocomplete on the review screen (TASK 57). Capped so the suggestion
 * source stays small and cheap.
 */
export async function listVendors(limit = 200): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ vendor: string }>(
    `SELECT vendor, MAX(created_at) as latest
     FROM receipts
     WHERE vendor IS NOT NULL AND vendor != ''
     GROUP BY vendor
     ORDER BY latest DESC
     LIMIT ?`,
    [limit],
  );
  return rows.map((r) => r.vendor);
}

export async function countReceipts(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) as n FROM receipts',
  );
  return row?.n ?? 0;
}
