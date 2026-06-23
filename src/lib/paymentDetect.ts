/**
 * Payment-method auto-detection from OCR / extraction text (TASK 41).
 *
 * Receipts very often print HOW the customer paid — the card network ("VISA",
 * "MASTERCARD", "AMEX"), the account type ("DEBIT", "CREDIT", "CASH"), a wallet
 * ("PAYPAL", "APPLE PAY") or a masked card number ("XXXX XXXX XXXX 1234",
 * "************4242", "ACCT ****1234"). We scan the OCR text for those signals
 * and pre-fill the review draft's payment method so the user doesn't have to
 * set it by hand (they always can override on the review screen).
 *
 * Pure / unit-testable — NO DB, network or RN deps. The caller passes in the
 * user's existing payment-method names (from the payment_methods table) so we
 * can map a detected brand onto the user's OWN method; when nothing matches we
 * still return a normalized brand label as a non-binding suggestion.
 *
 * Why on-device: ReceiptSnap is a one-time purchase, so this detection reuses
 * OCR text we already have and never costs a Gemini call.
 */

/** Coarse classification of how a receipt was paid. */
export type PaymentBrand =
  | 'cash'
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'discover'
  | 'credit'
  | 'debit'
  | 'gift_card'
  | 'paypal'
  | 'apple_pay'
  | 'google_pay';

/** Result of detecting the payment method from receipt text. */
export interface PaymentDetection {
  /** The normalized brand/method detected, or null when nothing was found. */
  brand: PaymentBrand | null;
  /** Human-readable label for the brand (e.g. "Visa", "Cash"). */
  label: string | null;
  /** Last 4 digits of the card, when a masked PAN was printed; else null. */
  last4: string | null;
  /**
   * Id of the user's matching payment method (when `paymentMethods` was supplied
   * and a name matched the detected brand); null when there is no match.
   */
  matchedId: string | null;
  /** Name of the matched user payment method (mirror of `matchedId`). */
  matchedName: string | null;
}

const EMPTY: PaymentDetection = {
  brand: null,
  label: null,
  last4: null,
  matchedId: null,
  matchedName: null,
};

/** Friendly label per brand for the non-binding suggestion. */
const BRAND_LABEL: Record<PaymentBrand, string> = {
  cash: 'Cash',
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  credit: 'Credit Card',
  debit: 'Debit Card',
  gift_card: 'Gift Card',
  paypal: 'PayPal',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
};

/**
 * A detection rule. Rules are evaluated MOST-SPECIFIC FIRST so a concrete brand
 * ("VISA") wins over a generic class ("CREDIT"), which in turn wins over the
 * broad "card" hints. The first matching rule decides the brand.
 */
interface BrandRule {
  brand: PaymentBrand;
  test: RegExp;
}

const RULES: BrandRule[] = [
  // Specific networks first.
  { brand: 'amex', test: /\bamex\b|american\s*express/ },
  { brand: 'visa', test: /\bvisa\b/ },
  { brand: 'mastercard', test: /\bmaster\s*card\b|\bmastercard\b|\bmc\b/ },
  { brand: 'discover', test: /\bdiscover\b/ },
  // Wallets.
  { brand: 'apple_pay', test: /\bapple\s*pay\b/ },
  { brand: 'google_pay', test: /\bgoogle\s*pay\b|\bg\s*pay\b|\bgpay\b/ },
  { brand: 'paypal', test: /\bpay\s*pal\b|\bpaypal\b/ },
  // Account types (after networks, before the generic "card").
  { brand: 'gift_card', test: /\bgift\s*card\b|\begift\b|\bgift\s*cert/ },
  { brand: 'debit', test: /\bdebit\b/ },
  { brand: 'credit', test: /\bcredit\b/ },
  // Cash last among words (so "cashier"/"cashback" don't trip it — see below).
  { brand: 'cash', test: /\bcash\b|\bcash\s*tender(?:ed)?\b/ },
];

/**
 * Extract the last 4 digits of a masked card number, if one is printed.
 *
 * Matches the common masked forms receipts use:
 *   - `XXXX XXXX XXXX 1234`, `**** **** **** 1234`
 *   - `************4242`, `xxxxxx4242`
 *   - `ACCT: ****1234`, `CARD #....1234`, `ENDING IN 1234`
 * Returns the 4 digits or null. We require the digits to be PRECEDED by mask
 * characters (or an explicit "ending in" phrase) so a normal price/date isn't
 * misread as a card number.
 */
export function detectLast4(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // "ending in 1234" / "ending 1234".
  const ending = lower.match(/ending(?:\s*in)?\s*[:#]?\s*(\d{4})\b/);
  if (ending) return ending[1];

  // A run of mask chars (x, *, .) immediately followed by exactly 4 digits.
  // Require at least 2 mask chars so "...1234" style (and full masks) match but
  // an ordinary 4-digit number does not.
  const masked = lower.match(/[x*.••]{2,}\s*(\d{4})\b/);
  if (masked) return masked[1];

  // Grouped mask blocks separated by spaces then 4 digits, e.g. "**** 1234".
  const grouped = lower.match(/(?:[x*••]{2,4}\s+){1,3}(\d{4})\b/);
  if (grouped) return grouped[1];

  return null;
}

/**
 * Normalize a payment-method NAME (user's or detected) to a comparison key for
 * matching: lower-cased, punctuation-stripped, whitespace-collapsed.
 */
function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does a user's payment-method name correspond to the detected brand? We match
 * on the brand's own keywords so "Credit Card", "Visa", "My Amex", "Cash" etc.
 * all resolve to the right user method.
 */
function nameMatchesBrand(name: string, brand: PaymentBrand): boolean {
  const n = normName(name);
  if (!n) return false;
  switch (brand) {
    case 'cash':
      return /\bcash\b/.test(n);
    case 'visa':
      return /\bvisa\b/.test(n);
    case 'mastercard':
      return /\bmaster\s*card\b|\bmastercard\b|\bmc\b/.test(n);
    case 'amex':
      return /\bamex\b|american express/.test(n);
    case 'discover':
      return /\bdiscover\b/.test(n);
    case 'paypal':
      return /\bpay\s*pal\b|\bpaypal\b/.test(n);
    case 'apple_pay':
      return /\bapple\s*pay\b/.test(n);
    case 'google_pay':
      return /\bgoogle\s*pay\b|\bgpay\b/.test(n);
    case 'gift_card':
      return /\bgift\b/.test(n);
    case 'debit':
      return /\bdebit\b/.test(n);
    case 'credit':
      // Generic credit OR a credit-network name the user labelled their card with.
      return /\bcredit\b|\bvisa\b|\bmaster\s*card\b|\bmastercard\b|\bamex\b|\bdiscover\b/.test(n);
    default:
      return false;
  }
}

/**
 * For a card-NETWORK brand (visa/amex/...), the user is most likely to have it
 * filed under a generic "Credit Card" method. This ordered fallback chain lets
 * `detectPayment` map "VISA" → the user's "Credit Card" when there is no
 * dedicated "Visa" method.
 */
const BRAND_FALLBACKS: Partial<Record<PaymentBrand, PaymentBrand[]>> = {
  visa: ['credit'],
  mastercard: ['credit'],
  amex: ['credit'],
  discover: ['credit'],
};

/**
 * Detect the payment method from OCR / extraction text and, when the user's
 * existing payment methods are supplied, map it onto one of them.
 *
 * @param text            Raw OCR text (and/or any extra extraction text).
 * @param paymentMethods  The user's existing methods ({id,name}); optional.
 * @returns               A PaymentDetection. `brand`/`label`/`last4` describe
 *                        what was read; `matchedId`/`matchedName` are set only
 *                        when a user method matched. All-null when nothing read.
 */
export function detectPayment(
  text: string | null | undefined,
  paymentMethods: { id: string; name: string }[] = [],
): PaymentDetection {
  const raw = (text ?? '').toLowerCase();
  if (!raw.trim()) return { ...EMPTY };

  let brand: PaymentBrand | null = null;
  for (const rule of RULES) {
    if (rule.test.test(raw)) {
      brand = rule.brand;
      break;
    }
  }

  const last4 = detectLast4(raw);
  // A masked PAN with no explicit brand still means "a card was used".
  if (!brand && last4) brand = 'credit';

  if (!brand) return { ...EMPTY, last4 };

  // Try to map onto one of the user's own payment methods: exact brand first,
  // then the brand's fallbacks (e.g. a Visa charge → the user's "Credit Card").
  let matchedId: string | null = null;
  let matchedName: string | null = null;
  const tryBrands: PaymentBrand[] = [brand, ...(BRAND_FALLBACKS[brand] ?? [])];
  outer: for (const b of tryBrands) {
    for (const pm of paymentMethods) {
      if (pm && pm.name && nameMatchesBrand(pm.name, b)) {
        matchedId = pm.id;
        matchedName = pm.name;
        break outer;
      }
    }
  }

  return {
    brand,
    label: BRAND_LABEL[brand],
    last4,
    matchedId,
    matchedName,
  };
}
