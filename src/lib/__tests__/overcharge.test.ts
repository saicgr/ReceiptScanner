/**
 * Unit tests for src/lib/overcharge.ts — duplicate / overcharge detection (TASK 83).
 */
import { detectChargeAnomalies } from '../overcharge';
import type { RawStatementLine } from '../statementMatch';

describe('detectChargeAnomalies', () => {
  it('flags two identical charges close together as a duplicate', () => {
    const lines: RawStatementLine[] = [
      { date: '2025-01-05', amount: 50.0, description: 'GADGET WORLD' },
      { date: '2025-01-06', amount: 50.0, description: 'GADGET WORLD' },
    ];
    const found = detectChargeAnomalies(lines);
    expect(found.length).toBe(1);
    expect(found[0].kind).toBe('duplicate');
    expect(found[0].lineIndexes.sort()).toEqual([0, 1]);
    expect(found[0].delta).toBe(50);
  });

  it('does NOT flag identical charges far apart (legit repeat / subscription)', () => {
    const lines: RawStatementLine[] = [
      { date: '2025-01-05', amount: 9.99, description: 'NETFLIX' },
      { date: '2025-02-05', amount: 9.99, description: 'NETFLIX' },
    ];
    const dup = detectChargeAnomalies(lines).filter((a) => a.kind === 'duplicate');
    expect(dup).toEqual([]);
  });

  it('flags two same-day charges differing modestly as a possible tip error', () => {
    const lines: RawStatementLine[] = [
      { date: '2025-03-01', amount: 40.0, description: 'BISTRO CAFE' },
      { date: '2025-03-01', amount: 48.0, description: 'BISTRO CAFE' }, // +20% tip
    ];
    const found = detectChargeAnomalies(lines);
    const over = found.find((a) => a.kind === 'overcharge');
    expect(over).toBeDefined();
    expect(over!.delta).toBe(8);
  });

  it('does not flag two same-day charges that differ wildly (separate purchases)', () => {
    const lines: RawStatementLine[] = [
      { date: '2025-03-01', amount: 5.0, description: 'BIG BOX' },
      { date: '2025-03-01', amount: 500.0, description: 'BIG BOX' },
    ];
    const over = detectChargeAnomalies(lines).filter((a) => a.kind === 'overcharge');
    expect(over).toEqual([]);
  });
});
