/**
 * Unit tests for src/lib/extractCacheKey.ts — the pure /extract cache-key
 * derivation (TASK 33). Verifies that identical requests collapse to one key and
 * that every output-affecting field changes the key, while order/casing of the
 * category hints does NOT (they're a set to the model).
 */
import { extractCacheKey } from '../extractCacheKey';

const BASE = {
  imageBase64: 'aGVsbG8=',
  ocrText: 'ACME STORE\nTOTAL 12.50',
  imageMimeType: 'image/jpeg',
  preferredDateFormat: 'MM/DD/YYYY',
  categoryHints: ['Groceries', 'Dining'],
};

describe('extractCacheKey', () => {
  it('is deterministic for identical input', () => {
    expect(extractCacheKey(BASE)).toBe(extractCacheKey({ ...BASE }));
  });

  it('ignores category-hint ORDER and casing', () => {
    const a = extractCacheKey(BASE);
    const b = extractCacheKey({ ...BASE, categoryHints: ['dining', 'groceries'] });
    expect(b).toBe(a);
  });

  it('changes when the image bytes change', () => {
    expect(extractCacheKey({ ...BASE, imageBase64: 'd29ybGQ=' })).not.toBe(
      extractCacheKey(BASE),
    );
  });

  it('changes when the OCR text changes', () => {
    expect(extractCacheKey({ ...BASE, ocrText: 'different' })).not.toBe(
      extractCacheKey(BASE),
    );
  });

  it('changes when the mime type changes', () => {
    expect(extractCacheKey({ ...BASE, imageMimeType: 'application/pdf' })).not.toBe(
      extractCacheKey(BASE),
    );
  });

  it('changes when the preferred date format changes', () => {
    expect(extractCacheKey({ ...BASE, preferredDateFormat: 'DD/MM/YYYY' })).not.toBe(
      extractCacheKey(BASE),
    );
  });

  it('changes when a category hint is added', () => {
    expect(
      extractCacheKey({ ...BASE, categoryHints: ['Groceries', 'Dining', 'Fuel'] }),
    ).not.toBe(extractCacheKey(BASE));
  });

  it('handles missing/empty fields without throwing', () => {
    expect(typeof extractCacheKey({})).toBe('string');
    expect(extractCacheKey({ imageBase64: null, ocrText: '' })).toBe(
      extractCacheKey({}),
    );
  });

  it('a text-only request differs from an image request', () => {
    const textOnly = extractCacheKey({ ...BASE, imageBase64: null });
    expect(textOnly).not.toBe(extractCacheKey(BASE));
  });
});
