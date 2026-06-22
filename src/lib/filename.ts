/**
 * Filename template engine — an explicit user demand the competitor ignored.
 *
 * The user defines a template of tokens (default "{date}_{company}_{amount}").
 * Tokens can be reordered/removed; the template applies automatically to every
 * scan AND powers batch re-naming of existing receipts.
 *
 * Pure / unit-testable.
 */
import { formatDate } from './dates';
import { round2 } from './money';

export const FILENAME_TOKENS = [
  '{date}',
  '{company}',
  '{amount}',
  '{currency}',
  '{category}',
  '{payment}',
  '{tax}',
  '{time}',
  '{id}',
] as const;

export type FilenameToken = (typeof FILENAME_TOKENS)[number];

export interface FilenameContext {
  date: string | null; // ISO
  vendor: string;
  total: number;
  currency: string;
  categoryName?: string | null;
  paymentName?: string | null;
  tax?: number | null;
  id: string;
  createdAt?: string; // ISO datetime, for {time}
}

/** Replace characters illegal in filenames across iOS/Android/Drive. */
export function sanitizeFilenamePart(value: string): string {
  return String(value)
    .replace(/[\/\\?%*:|"<>]/g, '') // illegal
    .replace(/[\s]+/g, '-') // spaces -> dash
    .replace(/[^\w.\-]/g, '') // keep word chars, dot, dash
    .replace(/\-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
}

/** Build the base filename (no extension) from a template + context. */
export function applyFilenameTemplate(
  template: string,
  ctx: FilenameContext,
  dateFormat = 'YYYY-MM-DD',
): string {
  const dateStr = ctx.date ? formatDate(ctx.date, dateFormat) : 'nodate';
  const timeStr = ctx.createdAt
    ? ctx.createdAt.slice(11, 19).replace(/:/g, '')
    : '';
  const values: Record<FilenameToken, string> = {
    '{date}': sanitizeFilenamePart(dateStr),
    '{company}': sanitizeFilenamePart(ctx.vendor || 'unknown'),
    '{amount}': sanitizeFilenamePart(round2(ctx.total).toFixed(2)),
    '{currency}': sanitizeFilenamePart(ctx.currency || ''),
    '{category}': sanitizeFilenamePart(ctx.categoryName || ''),
    '{payment}': sanitizeFilenamePart(ctx.paymentName || ''),
    '{tax}': sanitizeFilenamePart(ctx.tax != null ? round2(ctx.tax).toFixed(2) : ''),
    '{time}': sanitizeFilenamePart(timeStr),
    '{id}': sanitizeFilenamePart(ctx.id.slice(0, 8)),
  };

  let out = template;
  for (const token of FILENAME_TOKENS) {
    out = out.split(token).join(values[token]);
  }
  // Collapse separators left behind by empty tokens.
  out = out
    .replace(/[_\-]{2,}/g, (m) => m[0])
    .replace(/^[_\-.]+|[_\-.]+$/g, '');

  return out || `receipt-${ctx.id.slice(0, 8)}`;
}

/** Full filename including the chosen extension (jpg/png). */
export function buildFilename(
  template: string,
  ctx: FilenameContext,
  ext: 'jpg' | 'png',
  dateFormat = 'YYYY-MM-DD',
): string {
  return `${applyFilenameTemplate(template, ctx, dateFormat)}.${ext}`;
}

/** Validate a template; returns the unknown tokens it contains (if any). */
export function validateTemplate(template: string): {
  ok: boolean;
  unknownTokens: string[];
} {
  const used = template.match(/\{[a-z]+\}/gi) ?? [];
  const unknown = used.filter(
    (t) => !FILENAME_TOKENS.includes(t.toLowerCase() as FilenameToken),
  );
  return { ok: unknown.length === 0, unknownTokens: unknown };
}
