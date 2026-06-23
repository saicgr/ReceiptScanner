/**
 * Unit tests for src/lib/maps.ts — coordinate validation/formatting + the
 * native maps deep-link builder used by the receipt detail (TASK 47).
 */
import { hasValidCoords, formatCoords, mapsUrl } from '../maps';

describe('hasValidCoords', () => {
  it('accepts finite in-range coordinates including 0,0', () => {
    expect(hasValidCoords(37.4246, -122.084)).toBe(true);
    expect(hasValidCoords(0, 0)).toBe(true);
    expect(hasValidCoords(-90, 180)).toBe(true);
    expect(hasValidCoords(90, -180)).toBe(true);
  });

  it('rejects nulls, NaN, infinities and out-of-range values', () => {
    expect(hasValidCoords(null, 1)).toBe(false);
    expect(hasValidCoords(1, null)).toBe(false);
    expect(hasValidCoords(undefined, undefined)).toBe(false);
    expect(hasValidCoords(NaN, 0)).toBe(false);
    expect(hasValidCoords(0, Infinity)).toBe(false);
    expect(hasValidCoords(91, 0)).toBe(false);
    expect(hasValidCoords(0, -181)).toBe(false);
  });
});

describe('formatCoords', () => {
  it('uses N/E suffixes for positive values', () => {
    expect(formatCoords(37.4246, 122.084)).toBe('37.42460° N, 122.08400° E');
  });

  it('uses S/W suffixes and absolute values for negatives', () => {
    expect(formatCoords(-37.4246, -122.084)).toBe('37.42460° S, 122.08400° W');
  });

  it('honours a custom precision', () => {
    expect(formatCoords(1, -1, 2)).toBe('1.00° N, 1.00° W');
  });
});

describe('mapsUrl', () => {
  it('builds an Apple Maps url on iOS', () => {
    const url = mapsUrl({ lat: 37.4246, lng: -122.084 }, 'ios');
    expect(url).toBe('https://maps.apple.com/?ll=37.424600,-122.084000');
  });

  it('adds an encoded label query on iOS when provided', () => {
    const url = mapsUrl({ lat: 1, lng: 2 }, 'ios', 'Joe & Co');
    expect(url).toContain('https://maps.apple.com/?ll=1.000000,2.000000');
    expect(url).toContain('&q=Joe%20%26%20Co');
  });

  it('builds a Google Maps url on android and web (the default)', () => {
    const google = 'https://www.google.com/maps/search/?api=1&query=37.424600,-122.084000';
    expect(mapsUrl({ lat: 37.4246, lng: -122.084 }, 'android')).toBe(google);
    expect(mapsUrl({ lat: 37.4246, lng: -122.084 })).toBe(google);
  });
});
