/**
 * Unit tests for src/lib/statementMatch.ts — CSV statement parsing + matching.
 *
 * Verifies column auto-detection, debit/credit handling, date normalization,
 * and the greedy matcher producing matched lines, unmatched charges (possible
 * missing receipts) and unmatched receipts.
 */
import {
  detectColumns,
  MatchableReceipt,
  matchStatement,
  parseStatementCsv,
  RawStatementLine,
} from '../statementMatch';

describe('detectColumns', () => {
  it('detects date / amount / description columns case-insensitively', () => {
    const cols = detectColumns(['Posted Date', 'Amount', 'Description']);
    expect(cols.date).toBe('Posted Date');
    expect(cols.amount).toBe('Amount');
    expect(cols.description).toBe('Description');
  });

  it('detects separate debit/credit columns', () => {
    const cols = detectColumns(['Transaction Date', 'Debit', 'Credit', 'Payee']);
    expect(cols.debit).toBe('Debit');
    expect(cols.credit).toBe('Credit');
    expect(cols.description).toBe('Payee');
  });
});

describe('parseStatementCsv', () => {
  it('parses a standard amount-column statement into normalized lines', () => {
    const csv =
      'Date,Amount,Description\n' +
      '2025-01-05,12.50,COFFEE SHOP\n' +
      '01/06/2025,-42.00,GROCERY MART\n';
    const lines = parseStatementCsv(csv);
    expect(lines).toEqual([
      { date: '2025-01-05', amount: 12.5, description: 'COFFEE SHOP' },
      // amount is stored as absolute value; MM/DD/YYYY normalized to ISO.
      { date: '2025-01-06', amount: 42, description: 'GROCERY MART' },
    ]);
  });

  it('handles separate debit/credit columns and strips currency symbols', () => {
    const csv =
      'Date,Debit,Credit,Memo\n' +
      '2025-02-01,$15.00,,LUNCH\n' +
      '2025-02-02,,$100.00,REFUND\n';
    const lines = parseStatementCsv(csv);
    expect(lines).toEqual([
      { date: '2025-02-01', amount: 15, description: 'LUNCH' },
      { date: '2025-02-02', amount: 100, description: 'REFUND' },
    ]);
  });

  it('drops rows that have no parseable amount', () => {
    const csv = 'Date,Amount,Description\n2025-01-05,not-a-number,X\n';
    expect(parseStatementCsv(csv)).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseStatementCsv('')).toEqual([]);
  });
});

describe('matchStatement', () => {
  const lines: RawStatementLine[] = [
    { date: '2025-01-05', amount: 12.5, description: 'COFFEE SHOP' },
    { date: '2025-01-10', amount: 99.99, description: 'UNKNOWN CHARGE' },
  ];
  const receipts: MatchableReceipt[] = [
    { id: 'r1', date: '2025-01-05', total: 12.5, vendor: 'Coffee Shop' },
    { id: 'r2', date: '2025-03-01', total: 5.0, vendor: 'Bookstore' },
  ];

  it('matches a line to the receipt with equal amount + near date', () => {
    const res = matchStatement(lines, receipts);
    const m0 = res.matches[0];
    expect(m0.receiptId).toBe('r1');
    expect(m0.score).toBeGreaterThan(0.9); // exact amount + same date
    expect(m0.line.index).toBe(0);
  });

  it('flags an unmatched charge as a possible missing receipt', () => {
    const res = matchStatement(lines, receipts);
    // line index 1 (99.99) has no receipt.
    expect(res.matches[1].receiptId).toBeNull();
    expect(res.matches[1].score).toBe(0);
    expect(res.unmatchedLineIndexes).toEqual([1]);
  });

  it('reports receipts that never appear on the statement', () => {
    const res = matchStatement(lines, receipts);
    // r2 (bookstore) was never matched.
    expect(res.unmatchedReceiptIds).toEqual(['r2']);
  });

  it('does not match across the day window', () => {
    const far: MatchableReceipt[] = [
      { id: 'r1', date: '2025-02-20', total: 12.5, vendor: 'Coffee Shop' },
    ];
    const res = matchStatement(lines, far, { dayWindow: 4 });
    expect(res.matches[0].receiptId).toBeNull();
    expect(res.unmatchedReceiptIds).toEqual(['r1']);
  });

  it('does not match outside the amount tolerance', () => {
    const off: MatchableReceipt[] = [
      { id: 'r1', date: '2025-01-05', total: 13.0, vendor: 'Coffee Shop' },
    ];
    const res = matchStatement(lines, off, { amountTolerance: 0.01 });
    expect(res.matches[0].receiptId).toBeNull();
  });

  it('matches each receipt at most once (greedy, no reuse)', () => {
    const dupLines: RawStatementLine[] = [
      { date: '2025-01-05', amount: 12.5, description: 'A' },
      { date: '2025-01-05', amount: 12.5, description: 'B' },
    ];
    const oneReceipt: MatchableReceipt[] = [
      { id: 'r1', date: '2025-01-05', total: 12.5, vendor: 'Coffee Shop' },
    ];
    const res = matchStatement(dupLines, oneReceipt);
    const matchedIds = res.matches.map((m) => m.receiptId);
    expect(matchedIds.filter((id) => id === 'r1').length).toBe(1);
    expect(res.unmatchedLineIndexes.length).toBe(1); // the second 12.50 line
  });
});
