/**
 * Unit tests for src/lib/cardBenefits.ts — static card protection hints (TASK 77).
 */
import { cardBenefitHints } from '../cardBenefits';

describe('cardBenefitHints', () => {
  it('returns no hints for cash, debit, gift card, PayPal and blanks', () => {
    expect(cardBenefitHints('Cash')).toEqual([]);
    expect(cardBenefitHints('Debit Card')).toEqual([]);
    expect(cardBenefitHints('Gift Card')).toEqual([]);
    expect(cardBenefitHints('PayPal')).toEqual([]);
    expect(cardBenefitHints('')).toEqual([]);
    expect(cardBenefitHints(null)).toEqual([]);
    expect(cardBenefitHints(undefined)).toEqual([]);
  });

  it('surfaces common protections for a generic credit card', () => {
    const hints = cardBenefitHints('Credit Card');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.map((h) => h.kind)).toContain('warranty');
    expect(hints.map((h) => h.kind)).toContain('purchase_protection');
  });

  it('gives Amex the broadest benefit set including price protection', () => {
    const hints = cardBenefitHints('Amex Platinum');
    const kinds = hints.map((h) => h.kind);
    expect(kinds).toContain('warranty');
    expect(kinds).toContain('price_protection');
    expect(kinds).toContain('return_protection');
  });

  it('matches network names (Visa / Mastercard / Discover) case-insensitively', () => {
    expect(cardBenefitHints('VISA Signature').length).toBeGreaterThan(0);
    expect(cardBenefitHints('mastercard').length).toBeGreaterThan(0);
    expect(cardBenefitHints('Discover it').length).toBeGreaterThan(0);
  });

  it('does not treat a debit card as a benefit-bearing card even if named "visa debit"', () => {
    expect(cardBenefitHints('Visa Debit')).toEqual([]);
  });
});
