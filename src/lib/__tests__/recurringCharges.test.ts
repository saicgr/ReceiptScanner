/**
 * Unit tests for src/lib/recurringCharges.ts — subscription detection (TASK 82).
 */
import {
  cadenceLabel,
  detectRecurringCharges,
  merchantKey,
} from '../recurringCharges';
import type { RawStatementLine } from '../statementMatch';

describe('merchantKey', () => {
  it('collapses store numbers and noise so the same merchant groups together', () => {
    expect(merchantKey('NETFLIX.COM 866-579-7172 CA')).toBe(
      merchantKey('NETFLIX.COM'),
    );
  });

  it('returns an empty string for blank input', () => {
    expect(merchantKey('')).toBe('');
  });
});

describe('detectRecurringCharges', () => {
  it('flags a monthly subscription at the same amount and merchant', () => {
    const lines: RawStatementLine[] = [
      { date: '2025-01-03', amount: 15.99, description: 'NETFLIX.COM' },
      { date: '2025-02-03', amount: 15.99, description: 'NETFLIX.COM 866-1234' },
      { date: '2025-03-03', amount: 15.99, description: 'NETFLIX.COM' },
      { date: '2025-01-15', amount: 4.25, description: 'CORNER COFFEE' },
    ];
    const found = detectRecurringCharges(lines);
    expect(found.length).toBe(1);
    const sub = found[0];
    expect(sub.count).toBe(3);
    expect(sub.amount).toBe(15.99);
    expect(sub.lineIndexes.sort()).toEqual([0, 1, 2]);
    expect(sub.cadenceDays).toBeGreaterThanOrEqual(28);
    expect(sub.cadenceDays).toBeLessThanOrEqual(31);
    expect(sub.lastDate).toBe('2025-03-03');
  });

  it('does not flag a one-off purchase', () => {
    const lines: RawStatementLine[] = [
      { date: '2025-01-03', amount: 42.0, description: 'HARDWARE STORE' },
    ];
    expect(detectRecurringCharges(lines)).toEqual([]);
  });

  it('excludes a large one-off at a merchant that also has a subscription', () => {
    const lines: RawStatementLine[] = [
      { date: '2025-01-01', amount: 9.99, description: 'SPOTIFY' },
      { date: '2025-02-01', amount: 9.99, description: 'SPOTIFY' },
      { date: '2025-02-10', amount: 120.0, description: 'SPOTIFY GIFT' },
    ];
    const found = detectRecurringCharges(lines);
    expect(found.length).toBe(1);
    expect(found[0].count).toBe(2);
    expect(found[0].amount).toBe(9.99);
  });
});

describe('cadenceLabel', () => {
  it('labels common cadences', () => {
    expect(cadenceLabel(30)).toBe('monthly');
    expect(cadenceLabel(7)).toBe('weekly');
    expect(cadenceLabel(365)).toBe('yearly');
    expect(cadenceLabel(null)).toBe('recurring');
    expect(cadenceLabel(45)).toBe('every ~45 days');
  });
});
