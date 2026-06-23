/**
 * Credit-card purchase/return/warranty-protection HINTS (TASK 77).
 *
 * A static, on-device rules table keyed by the user's PAYMENT METHOD name. Many
 * credit cards commonly extend the manufacturer's warranty, offer price
 * protection, return protection or purchase protection on items bought with the
 * card. We can't read the user's actual card agreement, so these are GENERIC,
 * informational nudges ("This card may …") surfaced per receipt to prompt the
 * user to check their own benefits guide.
 *
 * Pure / unit-testable — no DB, no network, no RN deps. The matcher is keyed on
 * the lower-cased payment-method name so "Credit Card", "Visa Credit",
 * "Amex Card" etc. all resolve. Cash / debit / gift-card / PayPal get no hints.
 */
import type { CardBenefitHint } from '@/types';

/** A rule: if the payment-method name matches `test`, emit these hints. */
interface BenefitRule {
  test: (name: string) => boolean;
  hints: CardBenefitHint[];
}

const EXTENDED_WARRANTY: CardBenefitHint = {
  kind: 'warranty',
  title: 'Extended warranty',
  detail:
    'Many credit cards add up to a year to the manufacturer’s warranty on items bought with the card. Check your card’s benefits guide before this warranty lapses.',
};
const PRICE_PROTECTION: CardBenefitHint = {
  kind: 'price_protection',
  title: 'Price protection',
  detail:
    'Some cards refund the difference if the price drops within a set window. If you spot a lower price, you may be able to claim it back.',
};
const RETURN_PROTECTION: CardBenefitHint = {
  kind: 'return_protection',
  title: 'Return protection',
  detail:
    'If the retailer won’t take an unwanted item back, some cards will reimburse a recent purchase you can’t return.',
};
const PURCHASE_PROTECTION: CardBenefitHint = {
  kind: 'purchase_protection',
  title: 'Purchase protection',
  detail:
    'Many cards cover accidental damage or theft of a new purchase for a limited period. Keep this receipt as proof of purchase.',
};

/**
 * Rules are ordered most-specific first. Premium networks (Amex) commonly carry
 * the fullest benefit set; a generic "credit card" still gets the common ones.
 */
const RULES: BenefitRule[] = [
  {
    // American Express historically carries the broadest protections.
    test: (n) => /\bamex\b|american express/.test(n),
    hints: [EXTENDED_WARRANTY, PURCHASE_PROTECTION, RETURN_PROTECTION, PRICE_PROTECTION],
  },
  {
    // Generic credit cards (incl. Visa/Mastercard credit) — the common subset.
    // Exclude debit explicitly (debit cards rarely carry these benefits).
    test: (n) =>
      !/debit/.test(n) &&
      (/\bcredit\b/.test(n) || /\bvisa\b|master\s?card|\bmc\b|discover/.test(n)),
    hints: [EXTENDED_WARRANTY, PURCHASE_PROTECTION],
  },
];

/**
 * Return the protection hints for a payment-method name. Empty array for cash,
 * debit, gift cards, PayPal, an unknown/blank name, or null.
 */
export function cardBenefitHints(paymentMethodName: string | null | undefined): CardBenefitHint[] {
  const name = (paymentMethodName ?? '').trim().toLowerCase();
  if (!name) return [];
  for (const rule of RULES) {
    if (rule.test(name)) return rule.hints;
  }
  return [];
}
