/**
 * Unit tests for src/lib/recall.ts — CPSC recall parsing + matching (TASK 78).
 */
import {
  buildRecallUrl,
  matchRecall,
  parseRecalls,
  significantTerms,
} from '../recall';
import type { RecallRecord } from '@/types';

describe('buildRecallUrl', () => {
  it('always requests JSON and includes a title keyword when given', () => {
    const url = buildRecallUrl({ title: 'stroller' });
    expect(url).toContain('format=json');
    expect(url).toContain('RecallTitle=stroller');
  });

  it('omits the title param when none is given', () => {
    expect(buildRecallUrl()).not.toContain('RecallTitle');
  });
});

describe('parseRecalls', () => {
  const cachedAt = '2026-06-22T00:00:00.000Z';

  it('parses CPSC objects into compact records', () => {
    const json = [
      {
        RecallID: 10803,
        Title: 'ACME Toaster Recall',
        RecallDate: '2026-06-04T00:00:00',
        URL: 'https://example.com/recall',
        Products: [{ Name: 'ACME Toaster 2000', Description: 'Chrome toaster' }],
        Hazards: [{ Name: 'Fire Hazard' }],
      },
    ];
    const recs = parseRecalls(json, cachedAt);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      recall_id: '10803',
      title: 'ACME Toaster Recall',
      recall_date: '2026-06-04',
      url: 'https://example.com/recall',
      hazard: 'Fire Hazard',
    });
    expect(recs[0].product_text).toContain('toaster');
  });

  it('returns [] for non-array / empty input and skips id-less records', () => {
    expect(parseRecalls(null, cachedAt)).toEqual([]);
    expect(parseRecalls([{ Title: 'no id' }], cachedAt)).toEqual([]);
  });
});

describe('significantTerms', () => {
  it('drops stop-words, short tokens and pure numbers', () => {
    expect(significantTerms('Set of 2 Red Toaster 5000')).toEqual(['toaster']);
  });
});

describe('matchRecall', () => {
  const recall: RecallRecord = {
    recall_id: '1',
    title: 'Toaster recall',
    recall_date: '2026-06-04',
    url: '',
    hazard: 'Fire',
    product_text: 'acme toaster 2000 chrome kitchen appliance',
    cached_at: '',
  };

  it('matches on a significant shared term', () => {
    // "Kettle Toaster" -> "kettle" is absent, "toaster" is the matching term.
    expect(matchRecall('Kettle Toaster', recall)).toBe('toaster');
  });

  it('does not match on a generic / absent term', () => {
    expect(matchRecall('Blue Mug', recall)).toBeNull();
  });

  it('avoids substring false positives (word boundary)', () => {
    const r: RecallRecord = { ...recall, product_text: 'japan import lamp' };
    // "pan" should NOT match inside "japan".
    expect(matchRecall('frying pan', r)).toBeNull();
  });
});
