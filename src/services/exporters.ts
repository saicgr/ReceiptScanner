/**
 * exporters.ts — itemized export pipeline.
 *
 * The competitor's #1 export complaint was "exports only show totals, never the
 * line items, and drop my memo + tags". We solve that here: EVERY export is
 * ITEMIZED — one row per line item — and ALWAYS carries the memo and tag
 * columns. A receipt with no line items still emits a single summary row so it
 * is never silently dropped. The generic CSV/Excel export additionally carries
 * mileage trips and manual cash expenses as clearly-typed rows (see the Type
 * column), so it is the COMPLETE expense record.
 *
 * Supported targets (file formats only — no live accounting-API integrations):
 *   - csv / excel        → our generic itemized CSV (Excel opens .csv natively)
 *   - pdf                → a printable itemized report via expo-print
 *   - quickbooks_csv     → QuickBooks 3-column bank-import CSV (Date,Description,Amount)
 *   - quickbooks_iif     → QuickBooks .IIF transaction file (TRNS/SPL/ENDTRNS)
 *   - xero_csv           → Xero bank-statement CSV (Date,Amount,Payee,Description,Reference,AccountCode)
 *   - wave_csv           → Wave Accounting transaction CSV
 *
 * Files are written to the app cache (FileSystem.cacheDirectory) and handed to
 * the OS share sheet via expo-sharing. Nothing is uploaded anywhere.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import * as DB from '@/db';
import { getAllSettings } from '@/db/settings';
import { toCsv } from '@/lib/csv';
import { csvMoney, formatMoney, lineTotal, round2 } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import type {
  AccountingFormat,
  Category,
  ExportFilter,
  LineItem,
  PaymentMethod,
  ReceiptWithRelations,
  TaxCategory,
  TaxReportRow,
} from '@/types';

/** Provenance of an itemized row — surfaced as the CSV "Type" column. */
export type ExportRowType = 'Receipt' | 'Mileage' | 'Cash Expense';

/**
 * One fully-resolved itemized export row. Receipt-level fields are repeated on
 * each of the receipt's line items so the file is flat and pivot-table-friendly.
 * `memo` and `tags` are ALWAYS present (the explicit competitor fix).
 */
export interface ExportRow {
  rowType: ExportRowType;
  receiptId: string;
  date: string; // formatted per the user's date_format
  isoDate: string | null; // raw ISO for accounting targets that need a canonical date
  vendor: string;
  category: string;
  paymentMethod: string;
  taxCategory: string;
  currency: string;

  // Line-item columns (a summary row when the receipt has no items).
  itemName: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;

  // Receipt-level financials (repeated across the receipt's rows).
  receiptTotal: number;
  receiptTax: number;
  receiptSubtotal: number;

  // Always-included context columns.
  memo: string;
  tags: string; // semicolon-joined tag names

  // Tax intelligence.
  isDeductible: string; // 'Yes' | 'No'
  deductiblePercent: number;
  deductibleAmount: number; // lineTotal * deductiblePercent / 100

  status: string;
}

/** Human-friendly file-name stem per format, used for the written file. */
const FORMAT_META: Record<
  AccountingFormat,
  { ext: 'csv' | 'iif' | 'pdf' | 'html'; stem: string }
> = {
  csv: { ext: 'csv', stem: 'receipts' },
  excel: { ext: 'csv', stem: 'receipts' },
  pdf: { ext: 'pdf', stem: 'receipts' },
  html: { ext: 'html', stem: 'receipts' },
  quickbooks_csv: { ext: 'csv', stem: 'quickbooks' },
  quickbooks_iif: { ext: 'iif', stem: 'quickbooks' },
  xero_csv: { ext: 'csv', stem: 'xero' },
  wave_csv: { ext: 'csv', stem: 'wave' },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export receipts matching `filter` in `format`. Returns the written file uri.
 * Pull the data WITH relations so we have line items, tags and image pages, then
 * resolve category / payment / tax-category names from the lookup tables.
 */
export async function exportReceipts(
  format: AccountingFormat,
  filter: ExportFilter,
): Promise<string> {
  const [receipts, settings, categories, payments, taxCategories] =
    await Promise.all([
      DB.listReceiptsWithRelations(filter),
      getAllSettings(),
      DB.listCategories(),
      DB.listPaymentMethods(),
      DB.listTaxCategories(),
    ]);

  const lookups = buildLookups(categories, payments, taxCategories);
  const rows = receipts.flatMap((r) => receiptToRows(r, settings.date_format, lookups));

  let contents: string;
  switch (format) {
    case 'csv':
    case 'excel': {
      // The generic itemized export is the COMPLETE expense record: receipts
      // plus mileage trips and manual cash expenses ("mileage entries flow
      // into reports"), each tagged via the Type column.
      const extras = await extraExpenseRows(
        filter,
        settings.date_format,
        settings.default_currency,
        lookups,
      );
      contents = itemizedCsv([...rows, ...extras]);
      break;
    }
    case 'quickbooks_csv':
      contents = quickbooksCsv(receipts, settings.date_format);
      break;
    case 'quickbooks_iif':
      contents = quickbooksIif(receipts, lookups);
      break;
    case 'xero_csv':
      contents = xeroCsv(receipts);
      break;
    case 'wave_csv':
      contents = waveCsv(receipts, lookups);
      break;
    case 'html':
      return exportReceiptsHtml(filter);
    case 'pdf':
      return writePdf(itemizedHtml(rows), FORMAT_META.pdf.stem);
    default:
      // Exhaustive guard — keeps us honest if AccountingFormat grows.
      contents = itemizedCsv(rows);
      break;
  }

  const meta = FORMAT_META[format] ?? FORMAT_META.csv;
  return writeTextFile(contents, meta.stem, meta.ext);
}

/**
 * Export an EXPLICIT list of receipts (already loaded with relations) in one of
 * the file formats. Used by the folder-bundle export, where membership is a
 * many-to-many label that a plain ExportFilter can't express. The output is
 * identical to `exportReceipts` — fully itemized, memo + tags always present.
 * The accounting + mileage/cash extras are intentionally NOT mixed in here:
 * a folder bundle is a point-in-time snapshot of exactly those receipts.
 */
export async function exportReceiptList(
  format: AccountingFormat,
  receipts: ReceiptWithRelations[],
  stem: string,
): Promise<string> {
  const [settings, categories, payments, taxCategories] = await Promise.all([
    getAllSettings(),
    DB.listCategories(),
    DB.listPaymentMethods(),
    DB.listTaxCategories(),
  ]);
  const lookups = buildLookups(categories, payments, taxCategories);
  const rows = receipts.flatMap((r) =>
    receiptToRows(r, settings.date_format, lookups),
  );

  switch (format) {
    case 'html':
      return writeDocHtml(
        receiptsBrowserHtml(receipts, settings.date_format, lookups),
        stem,
      );
    case 'pdf':
      return writePdf(itemizedHtml(rows), stem);
    case 'quickbooks_csv':
      return writeTextFile(quickbooksCsv(receipts, settings.date_format), stem, 'csv');
    case 'quickbooks_iif':
      return writeTextFile(quickbooksIif(receipts, lookups), stem, 'iif');
    case 'xero_csv':
      return writeTextFile(xeroCsv(receipts), stem, 'csv');
    case 'wave_csv':
      return writeTextFile(waveCsv(receipts, lookups), stem, 'csv');
    case 'csv':
    case 'excel':
    default:
      return writeTextFile(itemizedCsv(rows), stem, 'csv');
  }
}

/**
 * Browse-anywhere HTML export. Writes a SINGLE self-contained .html file (inline
 * <style>, no external assets) into FileSystem.documentDirectory that the user
 * can open on any computer to browse ALL their receipts. Like every other
 * export it is fully ITEMIZED: a styled summary table plus, per receipt, a
 * visible sub-table of its line items (name, qty, unit price, line total).
 * Header carries totals grouped by currency and the generation date. Returns
 * the written file uri.
 */
export async function exportReceiptsHtml(filter: ExportFilter): Promise<string> {
  const [receipts, settings, categories, payments, taxCategories] =
    await Promise.all([
      DB.listReceiptsWithRelations(filter),
      getAllSettings(),
      DB.listCategories(),
      DB.listPaymentMethods(),
      DB.listTaxCategories(),
    ]);

  const lookups = buildLookups(categories, payments, taxCategories);
  const html = receiptsBrowserHtml(receipts, settings.date_format, lookups);
  return writeDocHtml(html, FORMAT_META.html.stem);
}

/**
 * Tax-report export (used by the Tax Report screen). Schedule-C style: one row
 * per tax category with gross + deductible amounts, grouped by currency.
 */
export async function exportTaxReport(
  rows: TaxReportRow[],
  opts: { year: number; format: 'csv' | 'pdf' },
): Promise<string> {
  if (opts.format === 'pdf') {
    return writePdf(taxReportHtml(rows, opts.year), `tax-report-${opts.year}`);
  }

  const headers = [
    'Tax Category',
    'Schedule C %',
    'Currency',
    'Gross Total',
    'Deductible Total',
    'Receipt Count',
  ];
  const body = rows.map((r) => [
    r.taxCategoryName,
    r.deductiblePercent,
    r.currency,
    money(r.grossTotal),
    money(r.deductibleTotal),
    r.count,
  ]);
  return writeTextFile(toCsv(headers, body), `tax-report-${opts.year}`, 'csv');
}

/** Open the OS share sheet for a previously written export file. */
export async function shareFile(uri: string): Promise<void> {
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      // Sharing is unavailable on some platforms (e.g. web); degrade quietly —
      // the file is still written to disk and its uri was returned to the caller.
      return;
    }
    await Sharing.shareAsync(uri);
  } catch {
    // Never let a cancelled / failed share crash the export flow.
  }
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

interface Lookups {
  categoryById: Map<string, Category>;
  paymentById: Map<string, PaymentMethod>;
  taxCategoryById: Map<string, TaxCategory>;
}

function buildLookups(
  categories: Category[],
  payments: PaymentMethod[],
  taxCategories: TaxCategory[],
): Lookups {
  return {
    categoryById: new Map(categories.map((c) => [c.id, c])),
    paymentById: new Map(payments.map((p) => [p.id, p])),
    taxCategoryById: new Map(taxCategories.map((t) => [t.id, t])),
  };
}

/**
 * Expand one receipt into its itemized rows. A receipt with line items yields
 * one row per item; a receipt with none yields a single summary row (so it is
 * never dropped). Split-transaction items keep their own category.
 */
function receiptToRows(
  receipt: ReceiptWithRelations,
  dateFormat: string,
  lookups: Lookups,
): ExportRow[] {
  const tags = receipt.tags.map((t) => t.name).join('; ');
  const payment = lookups.paymentById.get(receipt.payment_method_id ?? '')?.name ?? '';
  const taxCategory =
    lookups.taxCategoryById.get(receipt.tax_category_id ?? '')?.name ?? '';
  const receiptCategory =
    lookups.categoryById.get(receipt.category_id ?? '')?.name ?? 'Uncategorized';
  const date = formatDate(receipt.date, dateFormat);

  const base: Omit<
    ExportRow,
    'itemName' | 'qty' | 'unitPrice' | 'lineTotal' | 'category' | 'deductibleAmount'
  > = {
    rowType: 'Receipt',
    receiptId: receipt.id,
    date,
    isoDate: receipt.date,
    vendor: receipt.vendor,
    paymentMethod: payment,
    taxCategory,
    currency: receipt.currency,
    receiptTotal: round2(receipt.total),
    receiptTax: round2(receipt.tax ?? 0),
    receiptSubtotal: round2(receipt.subtotal),
    memo: receipt.memo,
    tags,
    isDeductible: receipt.is_deductible ? 'Yes' : 'No',
    deductiblePercent: receipt.deductible_percent,
    status: receipt.status,
  };

  const deductible = (amount: number): number =>
    receipt.is_deductible
      ? round2((amount * receipt.deductible_percent) / 100)
      : 0;

  if (!receipt.line_items.length) {
    // No itemization available — emit a faithful summary row.
    const amount = round2(receipt.total);
    return [
      {
        ...base,
        category: receiptCategory,
        itemName: '(no itemized detail)',
        qty: 1,
        unitPrice: amount,
        lineTotal: amount,
        deductibleAmount: deductible(amount),
      },
    ];
  }

  return receipt.line_items.map((li: LineItem): ExportRow => {
    const lt = lineTotal(li.qty, li.price);
    // An item's own (split-transaction) category overrides the receipt category.
    const itemCategory =
      lookups.categoryById.get(li.category_id ?? '')?.name ?? receiptCategory;
    return {
      ...base,
      category: itemCategory,
      itemName: li.included ? li.name : `${li.name} (excluded)`,
      qty: li.qty,
      unitPrice: round2(li.price),
      lineTotal: lt,
      deductibleAmount: deductible(lt),
    };
  });
}

// ---------------------------------------------------------------------------
// Mileage + cash-expense rows (generic CSV/Excel only)
// ---------------------------------------------------------------------------

/**
 * Build itemized rows for mileage trips and manual cash expenses so the generic
 * CSV/Excel export is the complete expense record. Both honour the export
 * filter where they can: date range, category and currency (trips carry no
 * currency of their own, so they count as the user's default currency). A tag
 * filter excludes them entirely — neither entity can carry tags, so they can
 * never match one. The accounting formats (QuickBooks/Xero/Wave) intentionally
 * stay receipts-only: those are bank-feed imports, and a mileage deduction is
 * not a bank transaction.
 */
async function extraExpenseRows(
  filter: ExportFilter,
  dateFormat: string,
  defaultCurrency: string,
  lookups: Lookups,
): Promise<ExportRow[]> {
  if (filter.tagIds?.length) return [];

  const inDateRange = (iso: string): boolean =>
    !!iso &&
    (!filter.startDate || iso >= filter.startDate) &&
    (!filter.endDate || iso <= filter.endDate);
  const inCategories = (id: string | null): boolean =>
    !filter.categoryIds?.length || (!!id && filter.categoryIds.includes(id));
  const catName = (id: string | null): string =>
    lookups.categoryById.get(id ?? '')?.name ?? 'Uncategorized';
  const taxName = (id: string | null): string =>
    lookups.taxCategoryById.get(id ?? '')?.name ?? '';

  const rows: ExportRow[] = [];

  // --- Mileage trips: one row each, fully deductible at the trip's stored rate.
  const tripCurrency = (defaultCurrency || 'USD').toUpperCase();
  if (!filter.currency || filter.currency === tripCurrency) {
    const trips = await DB.Mileage.listTrips();
    for (const tr of trips) {
      const iso = tr.start_time?.slice(0, 10) ?? '';
      if (!inDateRange(iso) || !inCategories(tr.category_id)) continue;
      const amount = round2(tr.amount);
      rows.push({
        rowType: 'Mileage',
        receiptId: tr.id,
        date: formatDate(iso, dateFormat),
        isoDate: iso,
        vendor: 'Mileage',
        category: catName(tr.category_id),
        paymentMethod: '',
        taxCategory: taxName(tr.tax_category_id),
        currency: tripCurrency,
        // Qty = miles, unit price = the per-mile rate persisted on the trip.
        itemName: `${tr.distance_miles} mi @ ${money(tr.rate_per_mile)}/mi`,
        qty: tr.distance_miles,
        unitPrice: tr.rate_per_mile,
        lineTotal: amount,
        receiptTotal: amount,
        receiptTax: 0,
        receiptSubtotal: amount,
        memo: tr.memo,
        tags: '',
        isDeductible: 'Yes',
        deductiblePercent: 100,
        deductibleAmount: amount,
        status: tr.is_manual ? 'manual' : 'gps',
      });
    }
  }

  // --- Manual cash expenses: one summary row each (they have no line items).
  const cashExpenses = await DB.CashExpenses.listCashExpenses();
  for (const ce of cashExpenses) {
    if (!inDateRange(ce.date) || !inCategories(ce.category_id)) continue;
    if (filter.currency && filter.currency !== ce.currency) continue;
    const amount = round2(ce.amount);
    rows.push({
      rowType: 'Cash Expense',
      receiptId: ce.id,
      date: formatDate(ce.date, dateFormat),
      isoDate: ce.date,
      vendor: ce.vendor,
      category: catName(ce.category_id),
      paymentMethod: lookups.paymentById.get(ce.payment_method_id ?? '')?.name ?? '',
      taxCategory: taxName(ce.tax_category_id),
      currency: ce.currency,
      itemName: '(cash expense)',
      qty: 1,
      unitPrice: amount,
      lineTotal: amount,
      receiptTotal: amount,
      receiptTax: 0,
      receiptSubtotal: amount,
      memo: ce.memo,
      tags: '',
      // Same is_deductible gating as receipts: the flag decides, % only scales.
      isDeductible: ce.is_deductible ? 'Yes' : 'No',
      deductiblePercent: ce.deductible_percent,
      deductibleAmount: ce.is_deductible
        ? round2((amount * ce.deductible_percent) / 100)
        : 0,
      status: 'cash',
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Generic itemized CSV / Excel
// ---------------------------------------------------------------------------

const ITEMIZED_HEADERS = [
  'Type', // 'Receipt' | 'Mileage' | 'Cash Expense' — keeps the merged file parseable
  'Date',
  'Vendor',
  'Item',
  'Qty',
  'Unit Price',
  'Line Total',
  'Category',
  'Payment Method',
  'Currency',
  'Receipt Total',
  'Tax',
  'Memo', // ALWAYS present (competitor fix)
  'Tags', // ALWAYS present (competitor fix)
  'Tax Category',
  'Deductible',
  'Deductible %',
  'Deductible Amount',
  'Status',
  'Receipt ID',
];

function itemizedCsv(rows: ExportRow[]): string {
  const body = rows.map((r) => [
    r.rowType,
    r.date,
    r.vendor,
    r.itemName,
    r.qty,
    money(r.unitPrice),
    money(r.lineTotal),
    r.category,
    r.paymentMethod,
    r.currency,
    money(r.receiptTotal),
    money(r.receiptTax),
    r.memo,
    r.tags,
    r.taxCategory,
    r.isDeductible,
    r.deductiblePercent,
    money(r.deductibleAmount),
    r.status,
    r.receiptId,
  ]);
  return toCsv(ITEMIZED_HEADERS, body);
}

// ---------------------------------------------------------------------------
// QuickBooks — bank-import CSV (3-column) + IIF
// ---------------------------------------------------------------------------

/**
 * QuickBooks 3-column bank CSV: Date, Description, Amount. QuickBooks bank feeds
 * expect one row per transaction, so we emit one row per RECEIPT (the itemized
 * detail lives in the generic CSV / IIF). Expenses are negative amounts.
 */
function quickbooksCsv(
  receipts: ReceiptWithRelations[],
  dateFormat: string,
): string {
  const headers = ['Date', 'Description', 'Amount'];
  const body = receipts.map((r) => {
    const desc = r.memo ? `${r.vendor} — ${r.memo}` : r.vendor;
    return [formatDate(r.date, dateFormat), desc, money(-Math.abs(r.total))];
  });
  return toCsv(headers, body);
}

/**
 * QuickBooks .IIF transaction file. Each receipt becomes one transaction:
 *   TRNS  ... (the bank/credit-card side, negative)
 *   SPL   ... (one split per line item, assigned to its category as an expense
 *              account; positive). Falls back to a single split for receipts
 *              without line items.
 *   ENDTRNS
 * Tab-delimited, as IIF requires. We use the !-prefixed header rows once.
 */
function quickbooksIif(receipts: ReceiptWithRelations[], lookups: Lookups): string {
  const lines: string[] = [
    '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO',
    '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO',
    '!ENDTRNS',
  ];

  const iifDate = (iso: string | null): string => {
    // IIF wants M/D/YYYY.
    if (!iso) return '';
    return formatDate(iso, 'M/D/YYYY');
  };
  const tabSafe = (s: string): string => (s ?? '').replace(/[\t\r\n]/g, ' ');

  for (const r of receipts) {
    const total = round2(r.total);
    const dt = iifDate(r.date);
    const memo = tabSafe(r.memo);
    const tags = r.tags.map((t) => t.name).join('; ');
    const trnsMemo = tabSafe([memo, tags && `tags: ${tags}`].filter(Boolean).join(' | '));

    // Bank/card side: money leaving the account is negative in IIF.
    lines.push(
      ['TRNS', 'CHECK', dt, 'Bank Account', tabSafe(r.vendor), money(-total), trnsMemo].join('\t'),
    );

    const splits =
      r.line_items.length > 0
        ? r.line_items
            .filter((li) => li.included)
            .map((li) => {
              const cat =
                lookups.categoryById.get(li.category_id ?? r.category_id ?? '')?.name ??
                'Uncategorized';
              return {
                account: cat,
                amount: lineTotal(li.qty, li.price),
                memo: tabSafe(li.name),
              };
            })
        : [
            {
              account:
                lookups.categoryById.get(r.category_id ?? '')?.name ?? 'Uncategorized',
              amount: total,
              memo: trnsMemo,
            },
          ];

    for (const s of splits) {
      // Expense splits are positive (they offset the negative bank line).
      lines.push(
        ['SPL', 'CHECK', dt, s.account, tabSafe(r.vendor), money(round2(s.amount)), s.memo].join('\t'),
      );
    }
    lines.push('ENDTRNS');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Xero — bank-statement CSV
// ---------------------------------------------------------------------------

/**
 * Xero bank-statement import format:
 *   Date, Amount, Payee, Description, Reference, AccountCode
 * One row per receipt. Description carries memo + tags so nothing is lost; the
 * receipt id is used as the Reference for reconciliation.
 */
function xeroCsv(receipts: ReceiptWithRelations[]): string {
  const headers = ['Date', 'Amount', 'Payee', 'Description', 'Reference', 'AccountCode'];
  const body = receipts.map((r) => {
    const tags = r.tags.map((t) => t.name).join('; ');
    const description = [r.memo, tags && `tags: ${tags}`].filter(Boolean).join(' | ');
    return [
      // Xero accepts ISO yyyy-mm-dd reliably across locales.
      r.date ?? '',
      money(-Math.abs(r.total)),
      r.vendor,
      description,
      r.id,
      '', // AccountCode left blank for the user to map on import.
    ];
  });
  return toCsv(headers, body);
}

// ---------------------------------------------------------------------------
// Wave — transaction CSV
// ---------------------------------------------------------------------------

/**
 * Wave Accounting transaction import:
 *   Date, Description, Amount, Category, Currency, Notes (memo + tags)
 * One row per receipt; expenses are negative.
 */
function waveCsv(receipts: ReceiptWithRelations[], lookups: Lookups): string {
  const headers = ['Date', 'Description', 'Amount', 'Category', 'Currency', 'Notes'];
  const body = receipts.map((r) => {
    const tags = r.tags.map((t) => t.name).join('; ');
    const notes = [r.memo, tags && `tags: ${tags}`].filter(Boolean).join(' | ');
    const category =
      lookups.categoryById.get(r.category_id ?? '')?.name ?? 'Uncategorized';
    return [
      r.date ?? '',
      r.vendor,
      money(-Math.abs(r.total)),
      category,
      r.currency,
      notes,
    ];
  });
  return toCsv(headers, body);
}

// ---------------------------------------------------------------------------
// PDF rendering (expo-print)
// ---------------------------------------------------------------------------

/** Escape user text for safe inline HTML. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PDF_STYLE = `
  <style>
    * { font-family: -apple-system, Helvetica, Arial, sans-serif; }
    body { color: #0F172A; font-size: 12px; margin: 24px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color: #64748B; margin: 0 0 16px; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #E2E8F0; vertical-align: top; }
    th { background: #F1F5F9; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
    td.num, th.num { text-align: right; }
    tr.receipt { background: #F8FAFC; font-weight: 600; }
    .memo { color: #475569; font-style: italic; }
    .tags { color: #0E7C66; }
  </style>
`;

/**
 * Build an itemized PDF: receipts grouped, each line item listed, with memo +
 * tags always shown. Rows are pre-resolved ExportRows so the grouping just keys
 * on receiptId.
 */
function itemizedHtml(rows: ExportRow[]): string {
  const grouped = new Map<string, ExportRow[]>();
  for (const r of rows) {
    const list = grouped.get(r.receiptId) ?? [];
    list.push(r);
    grouped.set(r.receiptId, list);
  }

  const generatedOn = formatDate(new Date().toISOString().slice(0, 10), 'MMMM D, YYYY');
  const blocks: string[] = [];

  for (const list of grouped.values()) {
    const head = list[0];
    const tail = head.memo || head.tags;
    const itemRows = list
      .map(
        (r) => `
        <tr>
          <td>${esc(r.itemName)}</td>
          <td class="num">${esc(r.qty)}</td>
          <td class="num">${esc(formatMoney(r.unitPrice, r.currency))}</td>
          <td class="num">${esc(formatMoney(r.lineTotal, r.currency))}</td>
          <td>${esc(r.category)}</td>
        </tr>`,
      )
      .join('');

    blocks.push(`
      <table style="margin-bottom:18px;">
        <tr class="receipt">
          <td colspan="3">${esc(head.date)} — <strong>${esc(head.vendor)}</strong></td>
          <td class="num">${esc(formatMoney(head.receiptTotal, head.currency))}</td>
          <td>${esc(head.paymentMethod || head.currency)}</td>
        </tr>
        <tr>
          <th>Item</th><th class="num">Qty</th><th class="num">Unit</th>
          <th class="num">Total</th><th>Category</th>
        </tr>
        ${itemRows}
        ${
          tail
            ? `<tr><td colspan="5">
                 ${head.memo ? `<span class="memo">${esc(head.memo)}</span>` : ''}
                 ${head.tags ? ` <span class="tags">#${esc(head.tags.replace(/; /g, ' #'))}</span>` : ''}
               </td></tr>`
            : ''
        }
      </table>`);
  }

  const body = blocks.length
    ? blocks.join('')
    : '<p class="sub">No receipts matched the selected filters.</p>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />${PDF_STYLE}</head>
    <body>
      <h1>ReceiptSnap — Itemized Export</h1>
      <p class="sub">Generated ${esc(generatedOn)} · ${grouped.size} receipt(s)</p>
      ${body}
    </body></html>`;
}

/** Extra styling layered on top of PDF_STYLE for the browse-anywhere HTML. */
const HTML_BROWSE_STYLE = `
  <style>
    body { max-width: 1040px; margin: 24px auto; padding: 0 16px; }
    .totals { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; }
    .pill { background: #F1F5F9; border: 1px solid #E2E8F0; border-radius: 999px;
            padding: 6px 12px; font-size: 12px; font-weight: 600; }
    .pill strong { color: #0E7C66; }
    .summary td.num, .summary th.num { text-align: right; }
    details { border: 1px solid #E2E8F0; border-radius: 8px; margin: 0 0 12px;
              overflow: hidden; background: #FFFFFF; }
    summary { list-style: none; cursor: pointer; padding: 10px 14px; background: #F8FAFC;
              display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
    summary::-webkit-details-marker { display: none; }
    summary .vendor { font-weight: 700; font-size: 14px; }
    summary .when { color: #64748B; font-size: 12px; }
    summary .amount { margin-left: auto; font-weight: 700; }
    summary .meta { color: #475569; font-size: 11px; width: 100%; }
    .items { margin: 0; }
    .items th, .items td { font-size: 11px; }
    .nowrap { white-space: nowrap; }
  </style>
`;

/**
 * Build the single self-contained browse-anywhere HTML document. Two layers of
 * itemization: a styled summary table (one row per receipt) AND a per-receipt
 * <details> block whose <summary> shows the receipt headline and whose body is
 * an itemized sub-table of every line item. Header lists per-currency totals
 * and the generation date.
 */
function receiptsBrowserHtml(
  receipts: ReceiptWithRelations[],
  dateFormat: string,
  lookups: Lookups,
): string {
  const generatedOn = formatDate(new Date().toISOString().slice(0, 10), 'MMMM D, YYYY');

  // Per-currency totals + count for the header.
  const totals = new Map<string, { total: number; count: number }>();
  for (const r of receipts) {
    const cur = totals.get(r.currency) ?? { total: 0, count: 0 };
    cur.total = round2(cur.total + r.total);
    cur.count += 1;
    totals.set(r.currency, cur);
  }
  const totalsPills = [...totals.entries()]
    .map(
      ([cur, agg]) =>
        `<span class="pill">${esc(agg.count)} receipt(s) · <strong>${esc(
          formatMoney(agg.total, cur),
        )}</strong> ${esc(cur)}</span>`,
    )
    .join('');

  const catName = (id: string | null): string =>
    lookups.categoryById.get(id ?? '')?.name ?? 'Uncategorized';
  const payName = (id: string | null): string =>
    lookups.paymentById.get(id ?? '')?.name ?? '';
  const taxName = (id: string | null): string =>
    lookups.taxCategoryById.get(id ?? '')?.name ?? '';

  // Summary table — one row per receipt with the requested columns.
  const summaryRows = receipts
    .map((r) => {
      const tags = r.tags.map((t) => t.name).join('; ');
      return `
        <tr>
          <td class="nowrap">${esc(formatDate(r.date, dateFormat))}</td>
          <td>${esc(r.vendor)}</td>
          <td>${esc(catName(r.category_id))}</td>
          <td>${esc(payName(r.payment_method_id))}</td>
          <td>${esc(r.currency)}</td>
          <td class="num nowrap">${esc(formatMoney(r.total, r.currency))}</td>
          <td class="num nowrap">${esc(formatMoney(r.tax ?? 0, r.currency))}</td>
          <td class="memo">${esc(r.memo)}</td>
          <td class="tags">${tags ? esc(tags) : ''}</td>
        </tr>`;
    })
    .join('');

  const summaryTable = receipts.length
    ? `<table class="summary">
         <tr>
           <th>Date</th><th>Vendor</th><th>Category</th><th>Payment</th>
           <th>Currency</th><th class="num">Total</th><th class="num">Tax</th>
           <th>Memo</th><th>Tags</th>
         </tr>
         ${summaryRows}
       </table>`
    : '<p class="sub">No receipts matched the selected filters.</p>';

  // Per-receipt itemized detail blocks.
  const detailBlocks = receipts
    .map((r) => {
      const tags = r.tags.map((t) => t.name).join('; ');
      const items = r.line_items.length
        ? r.line_items
        : null;

      const itemRows = items
        ? items
            .map((li) => {
              const lt = lineTotal(li.qty, li.price);
              const itemCat = catName(li.category_id ?? r.category_id);
              return `
              <tr>
                <td>${esc(li.included ? li.name : `${li.name} (excluded)`)}</td>
                <td class="num">${esc(li.qty)}</td>
                <td class="num nowrap">${esc(formatMoney(li.price, r.currency))}</td>
                <td class="num nowrap">${esc(formatMoney(lt, r.currency))}</td>
                <td>${esc(itemCat)}</td>
              </tr>`;
            })
            .join('')
        : `
            <tr>
              <td>(no itemized detail)</td>
              <td class="num">1</td>
              <td class="num nowrap">${esc(formatMoney(r.total, r.currency))}</td>
              <td class="num nowrap">${esc(formatMoney(r.total, r.currency))}</td>
              <td>${esc(catName(r.category_id))}</td>
            </tr>`;

      const metaParts = [
        `${esc(catName(r.category_id))}`,
        payName(r.payment_method_id) ? esc(payName(r.payment_method_id)) : '',
        taxName(r.tax_category_id) ? `tax: ${esc(taxName(r.tax_category_id))}` : '',
        r.is_deductible ? `deductible ${esc(r.deductible_percent)}%` : '',
        r.memo ? `memo: ${esc(r.memo)}` : '',
        tags ? `#${esc(tags.replace(/; /g, ' #'))}` : '',
      ].filter(Boolean);

      return `
        <details open>
          <summary>
            <span class="vendor">${esc(r.vendor)}</span>
            <span class="when">${esc(formatDate(r.date, dateFormat))}</span>
            <span class="amount">${esc(formatMoney(r.total, r.currency))} ${esc(r.currency)}</span>
            <span class="meta">${metaParts.join(' · ')}</span>
          </summary>
          <table class="items">
            <tr>
              <th>Item</th><th class="num">Qty</th><th class="num">Unit</th>
              <th class="num">Line Total</th><th>Category</th>
            </tr>
            ${itemRows}
          </table>
        </details>`;
    })
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ReceiptSnap — Receipts</title>
    ${PDF_STYLE}${HTML_BROWSE_STYLE}</head>
    <body>
      <h1>ReceiptSnap — Receipts</h1>
      <p class="sub">Generated ${esc(generatedOn)} · ${receipts.length} receipt(s)</p>
      <div class="totals">${totalsPills || '<span class="pill">No totals</span>'}</div>
      <h1 style="font-size:15px;margin:16px 0 8px;">Summary</h1>
      ${summaryTable}
      <h1 style="font-size:15px;margin:24px 0 8px;">Itemized detail</h1>
      ${detailBlocks || '<p class="sub">No receipts matched the selected filters.</p>'}
    </body></html>`;
}

/** Schedule-C style tax report PDF. */
function taxReportHtml(rows: TaxReportRow[], year: number): string {
  const byRow = rows
    .map(
      (r) => `
      <tr>
        <td>${esc(r.taxCategoryName)}</td>
        <td class="num">${esc(r.deductiblePercent)}%</td>
        <td>${esc(r.currency)}</td>
        <td class="num">${esc(formatMoney(r.grossTotal, r.currency))}</td>
        <td class="num">${esc(formatMoney(r.deductibleTotal, r.currency))}</td>
        <td class="num">${esc(r.count)}</td>
      </tr>`,
    )
    .join('');

  // Per-currency deductible totals footer.
  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.currency, round2((totals.get(r.currency) ?? 0) + r.deductibleTotal));
  }
  const footer = [...totals.entries()]
    .map(
      ([cur, amt]) =>
        `<tr class="receipt"><td colspan="4">Total deductible (${esc(cur)})</td>
         <td class="num">${esc(formatMoney(amt, cur))}</td><td></td></tr>`,
    )
    .join('');

  const body = rows.length
    ? `<table>
         <tr>
           <th>Tax Category</th><th class="num">Sched-C %</th><th>Currency</th>
           <th class="num">Gross</th><th class="num">Deductible</th><th class="num">Count</th>
         </tr>
         ${byRow}
         ${footer}
       </table>`
    : '<p class="sub">No deductible activity recorded for this period.</p>';

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />${PDF_STYLE}</head>
    <body>
      <h1>Tax Deduction Report — ${esc(year)}</h1>
      <p class="sub">Grouped by tax category · gross &amp; deductible totals per currency</p>
      ${body}
    </body></html>`;
}

// ---------------------------------------------------------------------------
// File writing helpers
// ---------------------------------------------------------------------------

/** Timestamped unique stem so repeated exports don't clobber each other. */
function uniqueName(stem: string, ext: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${stem}-${stamp}.${ext}`;
}

/** Where exports are staged before sharing (cache, not the receipts dir). */
const EXPORT_DIR = `${FileSystem.cacheDirectory}exports/`;

async function ensureExportDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(EXPORT_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
  }
}

/** Write UTF-8 text to the export dir and return its uri. */
async function writeTextFile(
  contents: string,
  stem: string,
  ext: string,
): Promise<string> {
  await ensureExportDir();
  const uri = `${EXPORT_DIR}${uniqueName(stem, ext)}`;
  await FileSystem.writeAsStringAsync(uri, contents, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return uri;
}

/**
 * Write a self-contained .html document to the persistent document directory
 * (FileSystem.documentDirectory) under a unique name, so the user can keep it
 * and open it on any computer. Returns the written file uri.
 */
async function writeDocHtml(html: string, stem: string): Promise<string> {
  const uri = `${FileSystem.documentDirectory ?? EXPORT_DIR}${uniqueName(stem, 'html')}`;
  await FileSystem.writeAsStringAsync(uri, html, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return uri;
}

/**
 * Render HTML to a PDF via expo-print, then move it into the export dir with a
 * friendly name (printToFileAsync writes to a random cache path).
 */
async function writePdf(html: string, stem: string): Promise<string> {
  await ensureExportDir();
  const { uri: tmpUri } = await Print.printToFileAsync({ html });
  const dest = `${EXPORT_DIR}${uniqueName(stem, 'pdf')}`;
  try {
    await FileSystem.moveAsync({ from: tmpUri, to: dest });
    return dest;
  } catch {
    // If the move fails (e.g. cross-volume on some platforms), the original
    // cache uri is still a valid, shareable PDF.
    return tmpUri;
  }
}

// ---------------------------------------------------------------------------
// Small formatting helper
// ---------------------------------------------------------------------------

/**
 * Plain two-decimal numeric string for spreadsheet/accounting columns. MUST be
 * locale-independent (dot decimal, NO thousands grouping): Intl.NumberFormat
 * can emit "1,234.50" or "1.234,50" depending on the device locale, which
 * corrupts QuickBooks/IIF/Xero/Wave imports and CSV parsing. Human-facing
 * HTML/PDF surfaces keep using formatMoney for locale-aware display.
 */
function money(n: number): string {
  return csvMoney(n);
}
