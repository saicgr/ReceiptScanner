/**
 * Unit tests for src/lib/money.ts — currency formatting + numeric helpers.
 *
 * `formatMoney` prefers Intl.NumberFormat; exact glyphs/grouping depend on the
 * host ICU build, so we assert structural/stable properties (decimals, digits,
 * the decimal-only path) rather than a brittle exact symbol string.
 */
import {
  csvMoney,
  currencySymbol,
  formatMoney,
  lineTotal,
  parseMoney,
  round2,
  sumIncluded,
} from '../money';

describe('round2', () => {
  it('rounds to two decimal places, half-up', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(1.234)).toBe(1.23);
  });
});

describe('currencySymbol', () => {
  it('maps known ISO codes to their symbol', () => {
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('eur')).toBe('€'); // case-insensitive
    expect(currencySymbol('GBP')).toBe('£');
  });

  it('falls back to "<CODE> " for unknown currencies', () => {
    expect(currencySymbol('XYZ')).toBe('XYZ ');
  });
});

describe('formatMoney', () => {
  it('always renders exactly two fraction digits', () => {
    // Whatever the grouping/symbol, the cents are fixed at 2 decimals.
    expect(formatMoney(1234.5, 'USD')).toMatch(/[.,]50\b/);
    expect(formatMoney(0, 'USD')).toMatch(/0[.,]00/);
  });

  it('omits the currency symbol in decimal mode (showSymbol:false)', () => {
    const out = formatMoney(1234.5, 'USD', { showSymbol: false });
    expect(out).not.toMatch(/\$/);
    // Plain decimal: digits + 2-place cents, no currency glyph.
    expect(out.replace(/[,\s]/g, '')).toBe('1234.50');
  });

  it('coerces non-finite amounts to 0.00', () => {
    expect(formatMoney(Number.NaN, 'USD', { showSymbol: false })).toBe('0.00');
    expect(formatMoney(Infinity, 'USD', { showSymbol: false })).toBe('0.00');
  });
});

describe('csvMoney', () => {
  it('emits plain dot-decimal with two places and NO grouping, in any locale', () => {
    // Locale-independent: never "1,234,567.50" / "1.234.567,50".
    expect(csvMoney(1234567.5)).toBe('1234567.50');
    expect(csvMoney(0)).toBe('0.00');
    expect(csvMoney(9.999)).toBe('10.00');
  });

  it('keeps the sign for negative (expense) amounts', () => {
    expect(csvMoney(-42.5)).toBe('-42.50');
  });

  it('coerces non-finite amounts to 0.00', () => {
    expect(csvMoney(Number.NaN)).toBe('0.00');
    expect(csvMoney(Infinity)).toBe('0.00');
  });
});

describe('parseMoney', () => {
  it('parses a plain number-ish string', () => {
    expect(parseMoney('42')).toBe(42);
    expect(parseMoney('42.50')).toBe(42.5);
  });

  it('strips currency symbols and thousands separators (US format)', () => {
    expect(parseMoney('$1,234.50')).toBe(1234.5);
    expect(parseMoney('USD 1,000')).toBe(1000);
  });

  it('handles European format where comma is the decimal separator', () => {
    // "1.234,50" -> 1234.50
    expect(parseMoney('1.234,50')).toBe(1234.5);
    // bare ",dd" decimal comma
    expect(parseMoney('9,99')).toBe(9.99);
  });

  it('treats comma as a thousands separator when it is not ",dd"', () => {
    expect(parseMoney('1,234')).toBe(1234);
  });

  it('keeps negatives and returns 0 for empty / non-numeric input', () => {
    expect(parseMoney('-12.34')).toBe(-12.34);
    expect(parseMoney('')).toBe(0);
    expect(parseMoney('abc')).toBe(0);
  });

  it('passes through an actual number argument', () => {
    // Defensive: callers sometimes pass a number despite the string signature.
    expect(parseMoney(15 as unknown as string)).toBe(15);
  });
});

describe('lineTotal', () => {
  it('multiplies qty * price rounded to 2dp', () => {
    expect(lineTotal(3, 2.5)).toBe(7.5);
    expect(lineTotal(3, 0.1)).toBe(0.3); // float-safe
  });

  it('treats missing qty/price as 0', () => {
    expect(lineTotal(0, 9.99)).toBe(0);
    expect(lineTotal(undefined as unknown as number, 5)).toBe(0);
  });
});

describe('sumIncluded', () => {
  it('sums only the included items (delete/untick recalculation)', () => {
    const items = [
      { qty: 2, price: 5, included: true }, // 10
      { qty: 1, price: 3, included: false }, // excluded
      { qty: 3, price: 1.5, included: true }, // 4.5
    ];
    expect(sumIncluded(items)).toBe(14.5);
  });

  it('returns 0 when nothing is included', () => {
    expect(
      sumIncluded([{ qty: 1, price: 9.99, included: false }]),
    ).toBe(0);
    expect(sumIncluded([])).toBe(0);
  });

  it('is float-safe across many small items', () => {
    const items = Array.from({ length: 3 }, () => ({
      qty: 1,
      price: 0.1,
      included: true,
    }));
    expect(sumIncluded(items)).toBe(0.3);
  });
});
