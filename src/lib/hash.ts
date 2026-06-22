/**
 * Content fingerprinting for duplicate detection. We build a normalized string
 * from the fields that identify a receipt (vendor + date + total + currency)
 * and hash it with a stable, synchronous 53-bit FNV-style hash so the same
 * receipt always produces the same fingerprint. Pure / unit-testable.
 */

export function normalizeVendor(vendor: string): string {
  return (vendor || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
}

/** cyrb53 — fast, well-distributed string hash returning a hex string. */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

export function contentHash(input: {
  vendor: string;
  date: string | null;
  total: number;
  currency: string;
}): string {
  const key = [
    normalizeVendor(input.vendor),
    input.date ?? 'nodate',
    Math.round((input.total || 0) * 100),
    (input.currency || 'USD').toUpperCase(),
  ].join('|');
  return cyrb53(key);
}

/**
 * Heuristic "near-duplicate" score in [0,1] between two receipts. 1.0 is an
 * exact fingerprint match; partial credit for same vendor + close amount +
 * near date. The Review/Scan flow warns when score >= 0.75.
 */
export function duplicateScore(
  a: { vendor: string; date: string | null; total: number; currency: string },
  b: { vendor: string; date: string | null; total: number; currency: string },
): number {
  if (contentHash(a) === contentHash(b)) return 1;
  let score = 0;
  if (normalizeVendor(a.vendor) && normalizeVendor(a.vendor) === normalizeVendor(b.vendor)) {
    score += 0.4;
  }
  if (a.currency?.toUpperCase() === b.currency?.toUpperCase()) {
    const diff = Math.abs((a.total || 0) - (b.total || 0));
    const rel = diff / Math.max(1, Math.abs(a.total || 0));
    if (diff < 0.01) score += 0.4;
    else if (rel < 0.02) score += 0.3;
    else if (rel < 0.1) score += 0.15;
  }
  if (a.date && b.date) {
    const da = Date.parse(a.date);
    const db = Date.parse(b.date);
    if (Number.isFinite(da) && Number.isFinite(db)) {
      const days = Math.abs(da - db) / 86400000;
      if (days === 0) score += 0.2;
      else if (days <= 2) score += 0.1;
    }
  }
  return Math.min(1, score);
}
