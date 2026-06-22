/** Currency formatting + small numeric helpers. Pure / unit-testable. */

const SYMBOLS: Record<string, string> = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', INR: '₹', AUD: 'A$',
  CAD: 'C$', CHF: 'CHF', MYR: 'RM', SGD: 'S$', HKD: 'HK$', NZD: 'NZ$',
  KRW: '₩', BRL: 'R$', MXN: 'MX$', ZAR: 'R', SEK: 'kr', NOK: 'kr', DKK: 'kr',
  PLN: 'zł', THB: '฿', IDR: 'Rp', PHP: '₱', AED: 'د.إ', SAR: '﷼',
};

export function currencySymbol(currency: string): string {
  return SYMBOLS[currency?.toUpperCase()] ?? `${currency} `;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Format an amount in its currency. Uses Intl.NumberFormat when available
 * (native + modern engines), otherwise a symbol + fixed-decimal fallback.
 */
export function formatMoney(
  amount: number,
  currency = 'USD',
  opts: { showSymbol?: boolean } = {},
): string {
  const { showSymbol = true } = opts;
  const safe = Number.isFinite(amount) ? amount : 0;
  try {
    const fmt = new Intl.NumberFormat(undefined, {
      style: showSymbol ? 'currency' : 'decimal',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return fmt.format(safe);
  } catch {
    const body = safe.toFixed(2);
    return showSymbol ? `${currencySymbol(currency)}${body}` : body;
  }
}

/**
 * Machine-readable money cell for CSV/IIF/accounting exports: plain dot-decimal,
 * two places, NO grouping. Intl.NumberFormat is locale-dependent ("1,234.50" or
 * "1.234,50"), which corrupts QuickBooks/Xero/Wave imports and Excel parsing —
 * human-facing surfaces should keep using formatMoney instead.
 */
export function csvMoney(n: number): string {
  const safe = Number.isFinite(n) ? n : 0;
  return safe.toFixed(2);
}

/** Parse a user-typed money string ("$1,234.50", "1.234,50") to a number. */
export function parseMoney(input: string): number {
  if (typeof input === 'number') return input;
  if (!input) return 0;
  let s = String(input).replace(/[^0-9.,\-]/g, '');
  // If both separators present, assume the last one is the decimal.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    // Comma only: treat as decimal if it looks like ",dd".
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export function lineTotal(qty: number, price: number): number {
  return round2((qty || 0) * (price || 0));
}

/** Sum included line items. Mirrors the DAO's recompute logic. */
export function sumIncluded(
  items: { qty: number; price: number; included: boolean }[],
): number {
  return round2(
    items
      .filter((i) => i.included)
      .reduce((s, i) => s + (i.qty || 0) * (i.price || 0), 0),
  );
}
