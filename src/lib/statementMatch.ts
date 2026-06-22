/**
 * Statement matching (lightweight, Expensify-style). Given parsed statement
 * lines and scanned receipts, match by amount (exact/near) + date proximity,
 * then surface unmatched charges (possible missing receipts) and unmatched
 * receipts. NO bank connections — operates entirely on imported CSV data.
 *
 * Pure / unit-testable — takes plain objects, returns plain results.
 */
import { parseCsvObjects } from './csv';
import { isValidIso } from './dates';

export interface RawStatementLine {
  date: string | null;
  amount: number;
  description: string;
}

export interface MatchableReceipt {
  id: string;
  date: string | null;
  total: number;
  vendor: string;
}

export interface LineMatch {
  line: RawStatementLine & { index: number };
  receiptId: string | null;
  score: number;
}

export interface StatementMatchResult {
  matches: LineMatch[];
  unmatchedLineIndexes: number[]; // possible missing receipts
  unmatchedReceiptIds: string[]; // scanned but not on statement
}

/** Heuristic detection of the date/amount/description columns in a CSV. */
export function detectColumns(headers: string[]): {
  date?: string;
  amount?: string;
  description?: string;
  debit?: string;
  credit?: string;
} {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const find = (...needles: string[]) =>
    headers.find((h) => needles.some((n) => norm(h).includes(n)));
  return {
    date: find('date', 'posted', 'transactiondate'),
    amount: find('amount', 'value'),
    description: find('description', 'payee', 'memo', 'details', 'narrative', 'name'),
    debit: find('debit', 'withdrawal'),
    credit: find('credit', 'deposit'),
  };
}

/** Parse a bank/card CSV into normalized statement lines. */
export function parseStatementCsv(text: string): RawStatementLine[] {
  const objects = parseCsvObjects(text);
  if (!objects.length) return [];
  const headers = Object.keys(objects[0]);
  const cols = detectColumns(headers);

  return objects
    .map((o): RawStatementLine | null => {
      const dateRaw = cols.date ? o[cols.date] : '';
      const date = normalizeDate(dateRaw);
      let amount = NaN;
      if (cols.amount && o[cols.amount]) amount = parseAmount(o[cols.amount]);
      else if (cols.debit && o[cols.debit]) amount = Math.abs(parseAmount(o[cols.debit]));
      else if (cols.credit && o[cols.credit]) amount = parseAmount(o[cols.credit]);
      const description = cols.description ? o[cols.description] : headers.map((h) => o[h]).join(' ');
      if (!Number.isFinite(amount)) return null;
      return { date, amount: Math.abs(amount), description: description || '' };
    })
    .filter((x): x is RawStatementLine => x !== null);
}

function parseAmount(s: string): number {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function normalizeDate(s: string): string | null {
  if (!s) return null;
  const t = s.trim();
  if (isValidIso(t)) return t.slice(0, 10);
  // MM/DD/YYYY or DD/MM/YYYY -> assume MM/DD if first <=12, fallback ISO build.
  const m = t.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
  if (m) {
    let [, a, b, c] = m;
    if (a.length === 4) return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
    const yr = c.length === 2 ? (+c <= 68 ? `20${c}` : `19${c}`) : c;
    const mm = +a <= 12 ? a : b;
    const dd = +a <= 12 ? b : a;
    return `${yr}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  const parsed = Date.parse(t);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

/**
 * Match statement lines to receipts. Greedy best-match: each receipt matched at
 * most once, to the closest line by amount equality + date proximity.
 *
 * @param amountTolerance absolute currency tolerance (default 0.00 exact)
 * @param dayWindow max |date difference| in days to allow a match (default 4)
 */
export function matchStatement(
  lines: RawStatementLine[],
  receipts: MatchableReceipt[],
  { amountTolerance = 0.01, dayWindow = 4 }: { amountTolerance?: number; dayWindow?: number } = {},
): StatementMatchResult {
  const usedReceipts = new Set<string>();
  const matches: LineMatch[] = [];

  lines.forEach((line, index) => {
    let best: { receipt: MatchableReceipt; score: number } | null = null;
    for (const r of receipts) {
      if (usedReceipts.has(r.id)) continue;
      const amountDiff = Math.abs(r.total - line.amount);
      if (amountDiff > amountTolerance) continue;
      let dayDiff = 0;
      if (line.date && r.date) {
        dayDiff = Math.abs(
          (Date.parse(line.date) - Date.parse(r.date)) / 86400000,
        );
        if (dayDiff > dayWindow) continue;
      }
      // Score: 1 for exact amount, decays with date distance.
      const amountScore = amountDiff < 0.01 ? 1 : 0.7;
      const dateScore = line.date && r.date ? Math.max(0, 1 - dayDiff / (dayWindow + 1)) : 0.5;
      const score = round2(amountScore * 0.6 + dateScore * 0.4);
      if (!best || score > best.score) best = { receipt: r, score };
    }
    if (best) {
      usedReceipts.add(best.receipt.id);
      matches.push({ line: { ...line, index }, receiptId: best.receipt.id, score: best.score });
    } else {
      matches.push({ line: { ...line, index }, receiptId: null, score: 0 });
    }
  });

  return {
    matches,
    unmatchedLineIndexes: matches.filter((m) => !m.receiptId).map((m) => m.line.index),
    unmatchedReceiptIds: receipts.filter((r) => !usedReceipts.has(r.id)).map((r) => r.id),
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
