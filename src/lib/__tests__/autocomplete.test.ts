/**
 * Unit tests for src/lib/autocomplete.ts — suggestion filtering (TASK 57).
 */
import { normalizeForMatch, suggest } from '../autocomplete';

describe('normalizeForMatch', () => {
  it('lower-cases and trims', () => {
    expect(normalizeForMatch('  Costco  ')).toBe('costco');
  });

  it('strips diacritics', () => {
    expect(normalizeForMatch('Café')).toBe('cafe');
  });
});

describe('suggest', () => {
  const pool = ['Costco', 'Coffee Bean', 'Whole Foods', 'Cosco Travel', 'costco'];

  it('returns nothing for an empty query by default', () => {
    expect(suggest('', pool)).toEqual([]);
  });

  it('ranks prefix matches before substring matches', () => {
    const out = suggest('co', ['Whole Foods', 'Tesco', 'Costco', 'Coffee']);
    // Prefix: Costco, Coffee; substring: Tesco.
    expect(out).toEqual(['Costco', 'Coffee', 'Tesco']);
  });

  it('is case-insensitive and de-duplicates by normalized form', () => {
    const out = suggest('cost', pool);
    // 'Costco' and 'costco' collapse to the first-seen 'Costco'.
    expect(out).toEqual(['Costco']);
  });

  it('never suggests the exact current input', () => {
    const out = suggest('Costco', ['Costco', 'Costco Wholesale']);
    expect(out).toEqual(['Costco Wholesale']);
  });

  it('respects the limit', () => {
    const big = Array.from({ length: 20 }, (_, i) => `Cafe ${i}`);
    expect(suggest('cafe', big, { limit: 3 })).toHaveLength(3);
  });

  it('drops empty/whitespace candidates', () => {
    expect(suggest('a', ['', '   ', 'Acme'])).toEqual(['Acme']);
  });

  it('surfaces all candidates when requireQuery is false and query is empty', () => {
    const out = suggest('', ['B', 'A', 'B'], { requireQuery: false });
    expect(out).toEqual(['B', 'A']); // de-duped, order preserved
  });
});
