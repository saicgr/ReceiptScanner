/**
 * Unit tests for src/lib/dates.ts — pure date utilities.
 *
 * Covers formatting, day arithmetic, day differences, ambiguous-vs-unambiguous
 * disambiguation (the competitor-beating date feature) and deadline math behind
 * warranty/return tracking. All UTC-safe so they never drift by timezone.
 */
import {
  addDays,
  daysBetween,
  deadlineFrom,
  disambiguate,
  formatDate,
  isValidIso,
  parseIso,
  taxYearBounds,
} from '../dates';

describe('parseIso / isValidIso', () => {
  it('parses a valid ISO date into y/m/d', () => {
    expect(parseIso('2025-12-05')).toEqual({ y: 2025, m: 12, d: 5 });
  });

  it('rejects malformed and out-of-range / impossible calendar dates', () => {
    expect(parseIso('not-a-date')).toBeNull();
    expect(parseIso('2025-13-01')).toBeNull(); // month out of range
    expect(parseIso('2025-02-30')).toBeNull(); // Feb 30 is impossible
    expect(parseIso('2025-00-10')).toBeNull(); // month 0
    expect(isValidIso('2024-02-29')).toBe(true); // leap year valid
    expect(isValidIso('2025-02-29')).toBe(false); // not a leap year
  });
});

describe('formatDate', () => {
  it('formats with the default MM/DD/YYYY pattern', () => {
    expect(formatDate('2025-01-09')).toBe('01/09/2025');
  });

  it('supports the common user-selectable tokens', () => {
    expect(formatDate('2025-12-05', 'YYYY-MM-DD')).toBe('2025-12-05');
    expect(formatDate('2025-12-05', 'DD/MM/YYYY')).toBe('05/12/2025');
    expect(formatDate('2025-12-05', 'D MMM YYYY')).toBe('5 Dec 2025');
    expect(formatDate('2025-12-05', 'MMMM D, YYYY')).toBe('December 5, 2025');
    expect(formatDate('2025-12-05', 'M/D/YY')).toBe('12/5/25');
  });

  it('renders the weekday token (dddd) from the calendar date', () => {
    // 2025-12-05 is a Friday.
    expect(formatDate('2025-12-05', 'dddd')).toBe('Friday');
  });

  it('returns empty string for null and passes through unparseable input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('garbage')).toBe('garbage');
  });
});

describe('addDays', () => {
  it('adds and subtracts whole days, rolling over months', () => {
    expect(addDays('2025-01-30', 5)).toBe('2025-02-04');
    expect(addDays('2025-03-01', -1)).toBe('2025-02-28');
  });

  it('crosses a year boundary correctly', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
  });

  it('returns input unchanged when the date is invalid', () => {
    expect(addDays('nope', 3)).toBe('nope');
  });
});

describe('daysBetween', () => {
  it('returns a positive difference when b is after a', () => {
    expect(daysBetween('2025-01-01', '2025-01-08')).toBe(7);
  });

  it('returns a negative difference when b is before a', () => {
    expect(daysBetween('2025-01-08', '2025-01-01')).toBe(-7);
  });

  it('returns 0 for identical dates or invalid input', () => {
    expect(daysBetween('2025-01-01', '2025-01-01')).toBe(0);
    expect(daysBetween('bad', '2025-01-01')).toBe(0);
  });
});

describe('disambiguate', () => {
  it('flags an ambiguous numeric date and surfaces every interpretation', () => {
    // "12/05/25": Dec 5 2025 (MDY) vs May 12 2025 (DMY) vs May 25 2012 (YMD).
    const r = disambiguate('12/05/25', 'MDY');
    expect(r.ambiguous).toBe(true);
    expect(r.options).toContain('2025-12-05'); // MDY
    expect(r.options).toContain('2025-05-12'); // DMY
    expect(r.options).toContain('2012-05-25'); // YMD (2-digit year first)
    expect(r.options.length).toBe(3);
    // Preferred order (MDY) comes first.
    expect(r.date).toBe('2025-12-05');
  });

  it('generates the year-first reading of the spec example "25/12/05"', () => {
    // "25/12/05" could be Dec 5 2025 (YMD) or Dec 25 2005 (DMY); 25 can never
    // be a month, so MDY drops out.
    const r = disambiguate('25/12/05', 'YMD');
    expect(r.ambiguous).toBe(true);
    expect(r.options).toContain('2025-12-05'); // YMD — the spec's reading
    expect(r.options).toContain('2005-12-25'); // DMY
    expect(r.options.length).toBe(2);
    // Preferred order (YMD) comes first.
    expect(r.date).toBe('2025-12-05');
    // A DMY-preferring user gets the day-first reading instead.
    expect(disambiguate('25/12/05', 'DMY').date).toBe('2005-12-25');
  });

  it('honours the preferred order when reordering candidates', () => {
    const r = disambiguate('12/05/25', 'DMY');
    expect(r.ambiguous).toBe(true);
    expect(r.date).toBe('2025-05-12'); // DMY first
  });

  it('is unambiguous when only one interpretation is a real calendar date', () => {
    // "25/12/2005": 25 can only be the day -> Dec 25 2005.
    const r = disambiguate('25/12/2005', 'MDY');
    expect(r.ambiguous).toBe(false);
    expect(r.options).toEqual(['2005-12-25']);
    expect(r.date).toBe('2005-12-25');
  });

  it('treats a leading 4-digit token as an unambiguous YMD date', () => {
    const r = disambiguate('2025-03-04', 'MDY');
    expect(r.ambiguous).toBe(false);
    expect(r.date).toBe('2025-03-04');
    expect(r.options).toEqual(['2025-03-04']);
  });

  it('collapses to one option when both orders produce the same date', () => {
    // "06/06/2020" -> June 6 2020 regardless of MDY/DMY.
    const r = disambiguate('06/06/2020', 'MDY');
    expect(r.ambiguous).toBe(false);
    expect(r.options).toEqual(['2020-06-06']);
  });

  it('expands 2-digit years around the 68/69 pivot', () => {
    // day=1, so the only ambiguity is month order; both yield the same date,
    // letting us assert the year-expansion pivot cleanly.
    expect(disambiguate('01/01/68', 'MDY').date).toBe('2068-01-01');
    expect(disambiguate('01/01/69', 'MDY').date).toBe('1969-01-01');
  });

  it('returns an empty result for non-date input', () => {
    const r = disambiguate('hello', 'MDY');
    expect(r).toEqual({ date: null, ambiguous: false, options: [] });
  });
});

describe('deadlineFrom', () => {
  it('computes purchase date + N days', () => {
    expect(deadlineFrom('2025-01-01', 30)).toBe('2025-01-31');
    expect(deadlineFrom('2025-01-01', 0)).toBe('2025-01-01');
  });

  it('returns null when the purchase date or day count is missing', () => {
    expect(deadlineFrom(null, 30)).toBeNull();
    expect(deadlineFrom('2025-01-01', null)).toBeNull();
    expect(deadlineFrom('2025-01-01', Number.NaN)).toBeNull();
  });
});

describe('taxYearBounds', () => {
  it('returns Jan 1 / Dec 31 bounds for the year', () => {
    expect(taxYearBounds(2025)).toEqual({ start: '2025-01-01', end: '2025-12-31' });
  });
});
