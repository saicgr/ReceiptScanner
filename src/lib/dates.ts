/**
 * Date utilities — formatting, flexible parsing, ambiguity detection and the
 * deadline math behind warranty/return tracking. Pure (no RN deps) so it is
 * fully unit-testable. ISO here means the date-only form "YYYY-MM-DD".
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Parse an ISO date-only string into y/m/d numbers (UTC-safe, no TZ drift). */
export function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const match = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const y = +match[1];
  const m = +match[2];
  const d = +match[3];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Validate real calendar date.
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

export function isValidIso(iso: string): boolean {
  return parseIso(iso) !== null;
}

/**
 * Format an ISO date using the user's preferred token format. Supported tokens:
 * YYYY, YY, MMMM, MMM, MM, M, DD, D, dddd. Anything else passes through.
 */
export function formatDate(iso: string | null, format = 'MM/DD/YYYY'): string {
  if (!iso) return '';
  const p = parseIso(iso);
  if (!p) return iso;
  const { y, m, d } = p;
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const pad = (n: number) => String(n).padStart(2, '0');
  return format
    .replace(/YYYY/g, String(y))
    .replace(/YY/g, String(y).slice(-2))
    .replace(/MMMM/g, MONTHS[m - 1])
    .replace(/MMM/g, MONTHS_SHORT[m - 1])
    .replace(/MM/g, pad(m))
    .replace(/\bM\b/g, String(m))
    .replace(/DD/g, pad(d))
    .replace(/\bD\b/g, String(d))
    .replace(/dddd/g, DAYS[weekday]);
}

/** Today's date as ISO date-only (local time). */
export function todayIso(): string {
  const now = new Date();
  return toIsoDate(now);
}

export function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Add (or subtract) whole days to an ISO date, returning ISO. */
export function addDays(iso: string, days: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Whole-day difference b - a (positive if b is after a). */
export function daysBetween(a: string, b: string): number {
  const pa = parseIso(a);
  const pb = parseIso(b);
  if (!pa || !pb) return 0;
  const ms =
    Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d);
  return Math.round(ms / 86400000);
}

/** Days from today until the given ISO date (negative if past). */
export function daysUntil(iso: string): number {
  return daysBetween(todayIso(), iso);
}

/** Deadline = purchase date + N days, as ISO (or null when inputs missing). */
export function deadlineFrom(purchaseIso: string | null, days: number | null): string | null {
  if (!purchaseIso || days == null || !Number.isFinite(days)) return null;
  return addDays(purchaseIso, days);
}

/**
 * Compute the plausible ISO interpretations of an ambiguous numeric date string
 * like "02/03/04" or "25/12/2005". Used as a local fallback / for tests; the
 * backend does the primary disambiguation. `preferred` orders the results.
 * Returns { date, ambiguous, options }.
 */
export function disambiguate(
  raw: string,
  preferred: 'MDY' | 'DMY' | 'YMD' = 'MDY',
): { date: string | null; ambiguous: boolean; options: string[] } {
  const parts = raw.trim().match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
  if (!parts) return { date: null, ambiguous: false, options: [] };

  const a = +parts[1];
  const b = +parts[2];
  const c = +parts[3];
  const candidates: { y: number; m: number; d: number; order: 'MDY' | 'DMY' | 'YMD' }[] = [];

  const expandYear = (n: number) => (n < 100 ? (n <= 68 ? 2000 + n : 1900 + n) : n);

  // YMD when first token is a 4-digit year.
  if (parts[1].length === 4) {
    candidates.push({ y: a, m: b, d: c, order: 'YMD' });
  } else {
    // MDY
    candidates.push({ y: expandYear(c), m: a, d: b, order: 'MDY' });
    // DMY
    candidates.push({ y: expandYear(c), m: b, d: a, order: 'DMY' });
    // YMD with a 2-digit year: "25/12/05" can also read as 2025-12-05 (the
    // spec's canonical example). Only plausible when the LAST token could be a
    // day — a 4-digit last token is certainly the year, so skip it there.
    if (parts[3].length <= 2) {
      candidates.push({ y: expandYear(a), m: b, d: c, order: 'YMD' });
    }
  }

  const valid = candidates
    .map((cd) => {
      const iso = `${String(cd.y).padStart(4, '0')}-${String(cd.m).padStart(2, '0')}-${String(cd.d).padStart(2, '0')}`;
      return { iso, valid: isValidIso(iso), order: cd.order };
    })
    .filter((x) => x.valid);

  // Order by preference, then dedupe.
  valid.sort((x, y) => (x.order === preferred ? -1 : y.order === preferred ? 1 : 0));
  const options = [...new Set(valid.map((v) => v.iso))];

  return {
    date: options[0] ?? null,
    ambiguous: options.length > 1,
    options,
  };
}

/** Friendly relative label for protection lists, e.g. "in 3 days", "today". */
export function relativeDays(iso: string): string {
  const n = daysUntil(iso);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 0) return `in ${n} days`;
  return `${Math.abs(n)} days ago`;
}

/** Start/end ISO bounds for a tax year. */
export function taxYearBounds(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}
