/**
 * Unit tests for src/lib/qrEncode.ts — the pure QR byte-mode encoder that backs
 * the receipt-sharing QR codes. We don't decode here (no scanner in unit land),
 * so we assert the structural invariants of the matrix (finder patterns, size,
 * version growth) and the capacity / oversize contract the share flow relies on.
 */
import {
  QrTooLargeError,
  encodeQr,
  fitsInQr,
  maxByteCapacity,
  utf8Bytes,
} from '../qrEncode';

describe('utf8Bytes', () => {
  it('encodes ASCII and multibyte characters', () => {
    expect(utf8Bytes('A')).toEqual([0x41]);
    expect(utf8Bytes('€').length).toBe(3);
    expect(utf8Bytes('☕').length).toBe(3);
  });
});

describe('encodeQr structure', () => {
  it('produces a square matrix sized 4*version+17', () => {
    const qr = encodeQr('hello', 'L');
    expect(qr.version).toBeGreaterThanOrEqual(1);
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.modules).toHaveLength(qr.size);
    expect(qr.modules[0]).toHaveLength(qr.size);
  });

  it('places the three finder patterns (dark 7x7 corners)', () => {
    const qr = encodeQr('hello', 'L');
    const n = qr.size;
    // Finder centers are dark; their surrounding ring corners are dark too.
    expect(qr.modules[0][0]).toBe(true);
    expect(qr.modules[0][6]).toBe(true);
    expect(qr.modules[6][0]).toBe(true);
    expect(qr.modules[0][n - 1]).toBe(true);
    expect(qr.modules[n - 1][0]).toBe(true);
    // The separator just inside a finder corner is light.
    expect(qr.modules[7][7]).toBe(false);
  });

  it('grows the version as the payload grows', () => {
    const small = encodeQr('hi', 'L');
    const big = encodeQr('x'.repeat(1000), 'L');
    expect(big.version).toBeGreaterThan(small.version);
  });

  it('is deterministic for the same input', () => {
    expect(encodeQr('repeatable', 'M')).toEqual(encodeQr('repeatable', 'M'));
  });
});

describe('capacity / oversize contract', () => {
  it('reports ~2953 bytes as the level-L cap', () => {
    expect(maxByteCapacity('L')).toBe(2953);
  });

  it('fitsInQr agrees with the cap', () => {
    expect(fitsInQr('x'.repeat(2953), 'L')).toBe(true);
    expect(fitsInQr('x'.repeat(2954), 'L')).toBe(false);
  });

  it('throws QrTooLargeError when the payload cannot fit', () => {
    expect(() => encodeQr('x'.repeat(3000), 'L')).toThrow(QrTooLargeError);
  });
});
