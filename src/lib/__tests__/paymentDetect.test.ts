/**
 * Unit tests for src/lib/paymentDetect.ts — payment-method auto-detection from
 * receipt OCR text (TASK 41).
 */
import { detectPayment, detectLast4 } from '../paymentDetect';

const METHODS = [
  { id: 'cash', name: 'Cash' },
  { id: 'bank', name: 'Bank Account' },
  { id: 'credit', name: 'Credit Card' },
  { id: 'debit', name: 'Debit Card' },
  { id: 'gift', name: 'Gift Card' },
  { id: 'paypal', name: 'PayPal' },
];

describe('detectPayment — brand detection', () => {
  it('returns all-null for empty / whitespace text', () => {
    expect(detectPayment('', METHODS).brand).toBeNull();
    expect(detectPayment('   ', METHODS).brand).toBeNull();
    expect(detectPayment(null, METHODS).brand).toBeNull();
    expect(detectPayment(undefined, METHODS).brand).toBeNull();
  });

  it('detects VISA / MASTERCARD / AMEX / DISCOVER networks (case-insensitive)', () => {
    expect(detectPayment('TOTAL 12.00\nVISA ****1234').brand).toBe('visa');
    expect(detectPayment('paid with MasterCard').brand).toBe('mastercard');
    expect(detectPayment('AMEX CREDIT').brand).toBe('amex');
    expect(detectPayment('American Express').brand).toBe('amex');
    expect(detectPayment('Discover it card').brand).toBe('discover');
  });

  it('detects CASH, DEBIT, CREDIT and GIFT CARD account types', () => {
    expect(detectPayment('CASH TENDERED 20.00').brand).toBe('cash');
    expect(detectPayment('DEBIT 9.99').brand).toBe('debit');
    expect(detectPayment('CREDIT SALE').brand).toBe('credit');
    expect(detectPayment('GIFT CARD balance 5.00').brand).toBe('gift_card');
  });

  it('detects PayPal / Apple Pay / Google Pay wallets', () => {
    expect(detectPayment('Paid via PayPal').brand).toBe('paypal');
    expect(detectPayment('Apple Pay').brand).toBe('apple_pay');
    expect(detectPayment('GOOGLE PAY').brand).toBe('google_pay');
  });

  it('prefers the specific network over the generic "credit" word', () => {
    // Both "VISA" and "CREDIT" appear; the specific network must win.
    expect(detectPayment('VISA CREDIT SALE').brand).toBe('visa');
  });

  it('treats a masked PAN with no brand word as a generic credit card', () => {
    const d = detectPayment('ACCT ************4242\nTOTAL 30.00');
    expect(d.brand).toBe('credit');
    expect(d.last4).toBe('4242');
  });

  it('surfaces a friendly label for the detected brand', () => {
    expect(detectPayment('VISA').label).toBe('Visa');
    expect(detectPayment('CASH').label).toBe('Cash');
    expect(detectPayment('amex').label).toBe('American Express');
  });
});

describe('detectPayment — mapping onto the user methods', () => {
  it('maps CASH onto the user Cash method', () => {
    const d = detectPayment('CASH TENDERED 20.00', METHODS);
    expect(d.matchedId).toBe('cash');
    expect(d.matchedName).toBe('Cash');
  });

  it('maps a VISA charge onto the user Credit Card when no dedicated Visa method exists', () => {
    const d = detectPayment('VISA ****1234', METHODS);
    expect(d.brand).toBe('visa');
    expect(d.matchedId).toBe('credit');
  });

  it('prefers a dedicated brand method over the generic credit fallback', () => {
    const withVisa = [...METHODS, { id: 'myvisa', name: 'My Visa' }];
    const d = detectPayment('VISA ****1234', withVisa);
    expect(d.matchedId).toBe('myvisa');
  });

  it('maps DEBIT onto the user Debit Card (not Credit Card)', () => {
    const d = detectPayment('DEBIT 9.99', METHODS);
    expect(d.matchedId).toBe('debit');
  });

  it('maps PayPal and Gift Card onto their user methods', () => {
    expect(detectPayment('Paid via PayPal', METHODS).matchedId).toBe('paypal');
    expect(detectPayment('GIFT CARD redeemed', METHODS).matchedId).toBe('gift');
  });

  it('returns a brand suggestion with no match when the user lacks a matching method', () => {
    const d = detectPayment('Apple Pay', METHODS);
    expect(d.brand).toBe('apple_pay');
    expect(d.label).toBe('Apple Pay');
    expect(d.matchedId).toBeNull();
    expect(d.matchedName).toBeNull();
  });
});

describe('detectLast4', () => {
  it('reads "ending in" forms', () => {
    expect(detectLast4('Card ending in 1234')).toBe('1234');
    expect(detectLast4('ending 5678')).toBe('5678');
  });

  it('reads masked PAN forms', () => {
    expect(detectLast4('************4242')).toBe('4242');
    expect(detectLast4('xxxx xxxx xxxx 0005')).toBe('0005');
    expect(detectLast4('ACCT: ....1234')).toBe('1234');
  });

  it('does not treat an ordinary 4-digit number (price/date) as a card', () => {
    expect(detectLast4('TOTAL 2024 items')).toBeNull();
    expect(detectLast4('Order 9999')).toBeNull();
  });
});
