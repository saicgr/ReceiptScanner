/**
 * reportConfig — pure logic for the export column picker (TASK 16).
 *
 * The user customizes which export columns appear, their order, the report mode
 * (per-line-item "single" vs per-receipt "group") and an optional header line.
 * This module owns the column vocabulary (id → human header), normalization of
 * a possibly-stale/partial persisted config, and the reorder/toggle helpers the
 * settings screen drives. The exporter (src/services/exporters.ts) reads the
 * normalized config to decide which cells to emit and in what order.
 *
 * Pure / unit-testable — no React, no DB.
 */
import {
  DEFAULT_REPORT_CONFIG,
  type ReportColumnId,
  type ReportConfig,
  type ReportMode,
} from '../types';

/** Canonical column order + the CSV header text each id maps to. */
export const REPORT_COLUMNS: { id: ReportColumnId; header: string }[] = [
  { id: 'type', header: 'Type' },
  { id: 'date', header: 'Date' },
  { id: 'vendor', header: 'Vendor' },
  { id: 'item', header: 'Item' },
  { id: 'qty', header: 'Qty' },
  { id: 'unit_price', header: 'Unit Price' },
  { id: 'line_total', header: 'Line Total' },
  { id: 'category', header: 'Category' },
  { id: 'payment_method', header: 'Payment Method' },
  { id: 'account', header: 'Account' },
  { id: 'currency', header: 'Currency' },
  { id: 'receipt_total', header: 'Receipt Total' },
  { id: 'tax', header: 'Tax' },
  { id: 'memo', header: 'Memo' },
  { id: 'tags', header: 'Tags' },
  { id: 'tax_category', header: 'Tax Category' },
  { id: 'deductible', header: 'Deductible' },
  { id: 'deductible_percent', header: 'Deductible %' },
  { id: 'deductible_amount', header: 'Deductible Amount' },
  { id: 'status', header: 'Status' },
  { id: 'receipt_id', header: 'Receipt ID' },
];

const HEADER_BY_ID = new Map<ReportColumnId, string>(
  REPORT_COLUMNS.map((c) => [c.id, c.header]),
);
const ALL_IDS = REPORT_COLUMNS.map((c) => c.id);
const VALID_ID = new Set<ReportColumnId>(ALL_IDS);

/** The CSV header text for a column id. */
export function columnHeader(id: ReportColumnId): string {
  return HEADER_BY_ID.get(id) ?? id;
}

/** Columns that only make sense per-line-item; hidden in 'group' mode. */
const LINE_ITEM_ONLY = new Set<ReportColumnId>([
  'item', 'qty', 'unit_price', 'line_total',
]);

/**
 * Coerce an arbitrary persisted value into a valid ReportConfig: drop unknown
 * column ids, de-duplicate, fall back to the default order when empty, and clamp
 * the mode. Defensive so an old/corrupt settings blob can never break exports.
 */
export function normalizeReportConfig(raw: unknown): ReportConfig {
  const r = (raw ?? {}) as Partial<ReportConfig>;

  const seen = new Set<ReportColumnId>();
  const columns: ReportColumnId[] = [];
  if (Array.isArray(r.columns)) {
    for (const c of r.columns) {
      if (VALID_ID.has(c as ReportColumnId) && !seen.has(c as ReportColumnId)) {
        seen.add(c as ReportColumnId);
        columns.push(c as ReportColumnId);
      }
    }
  }

  const mode: ReportMode = r.mode === 'group' ? 'group' : 'single';
  const header = typeof r.header === 'string' ? r.header : '';

  return {
    columns: columns.length ? columns : [...DEFAULT_REPORT_CONFIG.columns],
    mode,
    header,
  };
}

/**
 * The ORDERED, EFFECTIVE columns to emit for a given config: the user's order,
 * minus line-item-only columns when the report is in 'group' (per-receipt) mode
 * (a per-receipt row has no single item/qty/unit/line-total to show).
 */
export function effectiveColumns(config: ReportConfig): ReportColumnId[] {
  const cfg = normalizeReportConfig(config);
  if (cfg.mode === 'group') {
    return cfg.columns.filter((id) => !LINE_ITEM_ONLY.has(id));
  }
  return cfg.columns;
}

/** Is a column currently selected (visible)? */
export function isColumnSelected(config: ReportConfig, id: ReportColumnId): boolean {
  return normalizeReportConfig(config).columns.includes(id);
}

/**
 * Toggle a column on/off. Turning a column ON appends it in canonical position
 * relative to the OTHER selected columns (so it slots into a sensible default
 * place rather than always at the end); turning it OFF removes it. Removing the
 * last column is disallowed (a report needs at least one column) — the config is
 * returned unchanged in that case.
 */
export function toggleColumn(config: ReportConfig, id: ReportColumnId): ReportConfig {
  const cfg = normalizeReportConfig(config);
  if (cfg.columns.includes(id)) {
    if (cfg.columns.length <= 1) return cfg; // keep at least one column
    return { ...cfg, columns: cfg.columns.filter((c) => c !== id) };
  }
  // Insert preserving canonical relative order against currently-selected ids.
  const next = [...cfg.columns, id].sort(
    (a, b) => ALL_IDS.indexOf(a) - ALL_IDS.indexOf(b),
  );
  return { ...cfg, columns: next };
}

/** Move a selected column one step toward the start (up) of the order. */
export function moveColumnUp(config: ReportConfig, id: ReportColumnId): ReportConfig {
  const cfg = normalizeReportConfig(config);
  const i = cfg.columns.indexOf(id);
  if (i <= 0) return cfg;
  const columns = [...cfg.columns];
  [columns[i - 1], columns[i]] = [columns[i], columns[i - 1]];
  return { ...cfg, columns };
}

/** Move a selected column one step toward the end (down) of the order. */
export function moveColumnDown(config: ReportConfig, id: ReportColumnId): ReportConfig {
  const cfg = normalizeReportConfig(config);
  const i = cfg.columns.indexOf(id);
  if (i < 0 || i >= cfg.columns.length - 1) return cfg;
  const columns = [...cfg.columns];
  [columns[i + 1], columns[i]] = [columns[i], columns[i + 1]];
  return { ...cfg, columns };
}

/** Restore the full canonical default config. */
export function resetReportConfig(): ReportConfig {
  return {
    columns: [...DEFAULT_REPORT_CONFIG.columns],
    mode: 'single',
    header: '',
  };
}
