/**
 * Unit tests for src/lib/csv.ts — RFC-4180-ish parser + serializer.
 *
 * Verifies quoted fields, escaped quotes, embedded commas/newlines, header
 * object parsing, CRLF handling and round-trip-safe escaping in toCsv.
 */
import { objectsToCsv, parseCsv, parseCsvObjects, toCsv } from '../csv';

describe('parseCsv', () => {
  it('parses simple comma-separated rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields containing commas', () => {
    expect(parseCsv('name,note\n"Smith, John","hello, world"')).toEqual([
      ['name', 'note'],
      ['Smith, John', 'hello, world'],
    ]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsv('q\n"She said ""hi"""')).toEqual([
      ['q'],
      ['She said "hi"'],
    ]);
  });

  it('keeps newlines that occur inside quoted fields', () => {
    expect(parseCsv('a\n"line1\nline2"')).toEqual([
      ['a'],
      ['line1\nline2'],
    ]);
  });

  it('normalizes CRLF and CR line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r3,4')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('flushes the trailing field/row without a final newline', () => {
    expect(parseCsv('x,y')).toEqual([['x', 'y']]);
  });

  it('drops blank trailing lines', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('preserves empty fields between commas', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});

describe('parseCsvObjects', () => {
  it('maps rows to objects keyed by trimmed header', () => {
    const csv = ' Date , Amount \n2025-01-01, 10.00 ';
    expect(parseCsvObjects(csv)).toEqual([{ Date: '2025-01-01', Amount: '10.00' }]);
  });

  it('fills missing trailing cells with empty strings', () => {
    const csv = 'a,b,c\n1,2';
    expect(parseCsvObjects(csv)).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('returns an empty array when there are no data rows', () => {
    expect(parseCsvObjects('')).toEqual([]);
  });
});

describe('toCsv — escaping', () => {
  it('serializes headers and rows', () => {
    expect(toCsv(['a', 'b'], [[1, 2], [3, 4]])).toBe('a,b\n1,2\n3,4');
  });

  it('quotes fields containing commas, quotes or newlines', () => {
    const out = toCsv(
      ['name', 'note'],
      [['Smith, John', 'has "quotes"'], ['multi\nline', 'plain']],
    );
    expect(out).toBe(
      'name,note\n"Smith, John","has ""quotes"""\n"multi\nline",plain',
    );
  });

  it('renders null/undefined cells as empty strings', () => {
    expect(toCsv(['a', 'b'], [[null, undefined]])).toBe('a,b\n,');
  });

  it('passes machine money cells through unquoted (accounting-export shape)', () => {
    // Accounting exporters feed toCsv with csvMoney() cells — plain dot-decimal
    // with no grouping must never trigger quoting, so QuickBooks/Xero/Wave can
    // parse the column as a number regardless of device locale.
    expect(toCsv(['Date', 'Amount'], [['2026-01-05', '-1234.50']])).toBe(
      'Date,Amount\n2026-01-05,-1234.50',
    );
  });

  it('round-trips quoted/escaped data through parseCsv', () => {
    const headers = ['name', 'note'];
    const rows = [['Smith, John', 'said "hi"'], ['a\nb', 'c']];
    const csv = toCsv(headers, rows);
    expect(parseCsv(csv)).toEqual([headers, ...rows]);
  });
});

describe('objectsToCsv', () => {
  it('projects objects onto the chosen header order with escaping', () => {
    const out = objectsToCsv(
      ['vendor', 'memo'],
      [{ vendor: 'Acme, Inc', memo: 'thanks' }],
    );
    expect(out).toBe('vendor,memo\n"Acme, Inc",thanks');
  });
});
