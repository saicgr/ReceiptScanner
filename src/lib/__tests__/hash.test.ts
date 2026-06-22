/**
 * Unit tests for src/lib/hash.ts — content fingerprinting + duplicate scoring.
 *
 * Verifies hash stability (same logical receipt -> same hash, regardless of
 * vendor casing/punctuation), an exact-match score of 1.0, partial credit for
 * near-duplicates, and a clean miss for unrelated receipts.
 */
import {
  contentHash,
  cyrb53,
  duplicateScore,
  normalizeVendor,
} from '../hash';

const A = { vendor: 'Acme Coffee', date: '2025-12-05', total: 12.5, currency: 'USD' };

describe('normalizeVendor', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normalizeVendor('Acme Coffee, Inc.')).toBe('acmecoffeeinc');
  });

  it('caps to 24 chars and handles empty input', () => {
    expect(normalizeVendor('a'.repeat(40)).length).toBe(24);
    expect(normalizeVendor('')).toBe('');
  });
});

describe('cyrb53', () => {
  it('is deterministic for the same input', () => {
    expect(cyrb53('hello')).toBe(cyrb53('hello'));
  });

  it('returns a stable-width hex string and differs for different input', () => {
    const h = cyrb53('hello');
    expect(h).toMatch(/^[0-9a-f]+$/);
    expect(h.length).toBe(14);
    expect(cyrb53('hello')).not.toBe(cyrb53('world'));
  });
});

describe('contentHash — stability', () => {
  it('produces the same hash for the same logical receipt', () => {
    expect(contentHash(A)).toBe(contentHash({ ...A }));
  });

  it('ignores vendor casing and punctuation differences', () => {
    expect(contentHash(A)).toBe(
      contentHash({ ...A, vendor: 'ACME  Coffee!!!' }),
    );
  });

  it('is invariant to currency casing', () => {
    expect(contentHash(A)).toBe(contentHash({ ...A, currency: 'usd' }));
  });

  it('changes when an identifying field changes', () => {
    expect(contentHash(A)).not.toBe(contentHash({ ...A, total: 12.51 }));
    expect(contentHash(A)).not.toBe(contentHash({ ...A, date: '2025-12-06' }));
    expect(contentHash(A)).not.toBe(contentHash({ ...A, currency: 'EUR' }));
    expect(contentHash(A)).not.toBe(contentHash({ ...A, vendor: 'Different' }));
  });

  it('uses a "nodate" placeholder so null dates still hash deterministically', () => {
    const n1 = contentHash({ ...A, date: null });
    const n2 = contentHash({ ...A, date: null });
    expect(n1).toBe(n2);
    expect(n1).not.toBe(contentHash(A));
  });
});

describe('duplicateScore — exact', () => {
  it('scores 1.0 for an exact fingerprint match', () => {
    expect(duplicateScore(A, { ...A })).toBe(1);
  });

  it('scores 1.0 even when vendor casing/whitespace differs but hash matches', () => {
    expect(duplicateScore(A, { ...A, vendor: 'acme   coffee' })).toBe(1);
  });
});

describe('duplicateScore — near', () => {
  it('gives high partial credit for same vendor + near amount + near date', () => {
    // same vendor (0.4) + amount within 2% (0.3) + 1 day apart (0.1) = 0.8
    const b = { vendor: 'Acme Coffee', date: '2025-12-06', total: 12.6, currency: 'USD' };
    const s = duplicateScore(A, b);
    expect(s).toBeCloseTo(0.8, 5);
    expect(s).toBeGreaterThanOrEqual(0.75); // the warn threshold
  });

  it('credits an exact amount + exact date on the same vendor (just below 1.0)', () => {
    // vendor 0.4 + exact amount 0.4 + same date 0.2 would be 1.0, but those
    // identical fields make the fingerprint match -> short-circuit to 1.0.
    const exactDup = { vendor: 'Acme Coffee', date: '2025-12-05', total: 12.5, currency: 'USD' };
    expect(duplicateScore(A, exactDup)).toBe(1);
  });

  it('gives only mild credit when the amount is moderately different', () => {
    // vendor 0.4 + ~8% amount diff (0.15) + same date (0.2) = 0.75
    const b = { vendor: 'Acme Coffee', date: '2025-12-05', total: 13.5, currency: 'USD' };
    expect(duplicateScore(A, b)).toBeCloseTo(0.75, 5);
  });

  it('does not credit amount when currencies differ', () => {
    const b = { vendor: 'Acme Coffee', date: '2025-12-05', total: 12.5, currency: 'EUR' };
    // vendor 0.4 + same date 0.2, but no amount credit (currency mismatch).
    expect(duplicateScore(A, b)).toBeCloseTo(0.6, 5);
  });

  it('scores low for an unrelated receipt', () => {
    const b = { vendor: 'Bistro Nine', date: '2024-01-01', total: 99.99, currency: 'USD' };
    expect(duplicateScore(A, b)).toBeLessThan(0.75);
  });

  it('caps the score at 1.0', () => {
    expect(duplicateScore(A, { ...A })).toBeLessThanOrEqual(1);
  });
});
