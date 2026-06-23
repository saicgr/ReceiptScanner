/**
 * autocomplete — pure suggestion filtering for the review/edit screen (TASK 57).
 *
 * Given the user's partial input and a pool of existing values (e.g. every
 * vendor they've scanned, or their category names), return the best-matching
 * suggestions. Matching is case-insensitive and diacritic-insensitive; results
 * are de-duplicated (keeping the first-seen casing), ranked prefix-first then
 * substring, and capped. The exact current input is never suggested back to the
 * user (typing "Costco" shouldn't suggest "Costco").
 *
 * Pure / unit-testable — no React, no DB. The screen passes in the candidate
 * pool it already loaded (vendor history, lookup names).
 */

/** Lower-case + strip diacritics so "Café" matches "cafe". */
export function normalizeForMatch(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export interface SuggestOptions {
  /** Maximum number of suggestions to return (default 5). */
  limit?: number;
  /**
   * When true (default), an empty/whitespace query yields no suggestions. Set
   * false to surface the most recent/top candidates before the user types.
   */
  requireQuery?: boolean;
}

/**
 * Rank `candidates` against `query`. Prefix matches rank above substring
 * matches; within a tier the original input order is preserved (callers pass
 * candidates most-recent/most-frequent first). Duplicates (by normalized form)
 * collapse to their first occurrence, and any candidate equal to the query is
 * dropped.
 */
export function suggest(
  query: string,
  candidates: string[],
  opts: SuggestOptions = {},
): string[] {
  const { limit = 5, requireQuery = true } = opts;
  const q = normalizeForMatch(query);
  if (requireQuery && q.length === 0) return [];

  const seen = new Set<string>();
  const prefix: string[] = [];
  const substring: string[] = [];

  for (const raw of candidates) {
    const value = (raw ?? '').trim();
    if (!value) continue;
    const norm = normalizeForMatch(value);
    if (seen.has(norm)) continue;
    seen.add(norm);

    // Never suggest the exact thing the user already typed.
    if (norm === q) continue;

    if (q.length === 0) {
      // No query (requireQuery=false): surface candidates as-is.
      prefix.push(value);
    } else if (norm.startsWith(q)) {
      prefix.push(value);
    } else if (norm.includes(q)) {
      substring.push(value);
    }
  }

  return [...prefix, ...substring].slice(0, limit);
}
