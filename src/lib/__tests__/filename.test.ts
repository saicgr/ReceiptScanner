/**
 * Unit tests for src/lib/filename.ts — the user-configurable filename engine.
 *
 * Verifies the default {date}_{company}_{amount} template, token
 * removal/reorder, illegal-character sanitization, empty-token separator
 * collapsing, full filename (with extension) and template validation.
 */
import {
  applyFilenameTemplate,
  buildFilename,
  FILENAME_TOKENS,
  FilenameContext,
  sanitizeFilenamePart,
  validateTemplate,
} from '../filename';

/** A representative receipt context reused across cases. */
const baseCtx: FilenameContext = {
  date: '2025-12-05',
  vendor: 'Acme Coffee',
  total: 12.5,
  currency: 'USD',
  categoryName: 'Meals',
  paymentName: 'Credit Card',
  tax: 1.05,
  id: 'abcd1234-ef56-7890-aaaa-bbbbbbbbbbbb',
  createdAt: '2025-12-05T14:03:09.000Z',
};

describe('sanitizeFilenamePart', () => {
  it('strips filesystem-illegal characters', () => {
    expect(sanitizeFilenamePart('a/b\\c:d?e*f|g"h<i>j%k')).toBe('abcdefghijk');
  });

  it('converts whitespace runs to a single dash', () => {
    expect(sanitizeFilenamePart('Acme   Coffee  Co')).toBe('Acme-Coffee-Co');
  });

  it('collapses repeated dashes and trims leading/trailing separators', () => {
    expect(sanitizeFilenamePart('--Acme--Co--')).toBe('Acme-Co');
    expect(sanitizeFilenamePart('.hidden.')).toBe('hidden');
  });

  it('caps the part length at 60 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeFilenamePart(long).length).toBe(60);
  });
});

describe('applyFilenameTemplate — default template', () => {
  it('renders {date}_{company}_{amount} and NOTHING else by default', () => {
    const out = applyFilenameTemplate('{date}_{company}_{amount}', baseCtx);
    // default date format is YYYY-MM-DD inside applyFilenameTemplate.
    expect(out).toBe('2025-12-05_Acme-Coffee_12.50');
  });

  it('respects a custom date format for the {date} token', () => {
    const out = applyFilenameTemplate(
      '{date}_{company}_{amount}',
      baseCtx,
      'MM-DD-YYYY',
    );
    expect(out).toBe('12-05-2025_Acme-Coffee_12.50');
  });

  it('formats the amount with two decimals via {amount}', () => {
    const out = applyFilenameTemplate('{amount}', { ...baseCtx, total: 7 });
    expect(out).toBe('7.00');
  });
});

describe('applyFilenameTemplate — token removal / reorder', () => {
  it('supports reordering tokens', () => {
    const out = applyFilenameTemplate('{company}_{date}', baseCtx);
    expect(out).toBe('Acme-Coffee_2025-12-05');
  });

  it('supports removing tokens (only what the user kept appears)', () => {
    const out = applyFilenameTemplate('{company}', baseCtx);
    expect(out).toBe('Acme-Coffee');
  });

  it('renders the extra tokens: currency, category, payment, tax, time, id', () => {
    expect(applyFilenameTemplate('{currency}', baseCtx)).toBe('USD');
    expect(applyFilenameTemplate('{category}', baseCtx)).toBe('Meals');
    expect(applyFilenameTemplate('{payment}', baseCtx)).toBe('Credit-Card');
    expect(applyFilenameTemplate('{tax}', baseCtx)).toBe('1.05');
    expect(applyFilenameTemplate('{time}', baseCtx)).toBe('140309');
    expect(applyFilenameTemplate('{id}', baseCtx)).toBe('abcd1234');
  });

  it('collapses separators left behind by empty tokens', () => {
    // No payment name -> {payment} resolves empty; the surrounding underscores
    // must collapse rather than leave "Acme__12.50".
    const ctx: FilenameContext = { ...baseCtx, paymentName: '' };
    const out = applyFilenameTemplate('{company}_{payment}_{amount}', ctx);
    expect(out).toBe('Acme-Coffee_12.50');
  });

  it('uses "nodate"/"unknown" fallbacks for missing date / vendor', () => {
    const ctx: FilenameContext = { ...baseCtx, date: null, vendor: '' };
    expect(applyFilenameTemplate('{date}_{company}', ctx)).toBe('nodate_unknown');
  });

  it('falls back to receipt-<id> when the template renders empty', () => {
    const ctx: FilenameContext = { ...baseCtx, paymentName: '' };
    // {payment} is the only token and it is empty.
    expect(applyFilenameTemplate('{payment}', ctx)).toBe('receipt-abcd1234');
  });
});

describe('buildFilename', () => {
  it('appends the chosen image extension', () => {
    expect(buildFilename('{company}', baseCtx, 'jpg')).toBe('Acme-Coffee.jpg');
    expect(buildFilename('{company}', baseCtx, 'png')).toBe('Acme-Coffee.png');
  });

  it('combines template + date format + extension', () => {
    expect(
      buildFilename('{date}_{amount}', baseCtx, 'png', 'YYYYMMDD'),
    ).toBe('20251205_12.50.png');
  });
});

describe('validateTemplate', () => {
  it('accepts a template built only from known tokens', () => {
    expect(validateTemplate('{date}_{company}_{amount}')).toEqual({
      ok: true,
      unknownTokens: [],
    });
  });

  it('accepts a template with no tokens at all (literal name)', () => {
    expect(validateTemplate('receipt')).toEqual({ ok: true, unknownTokens: [] });
  });

  it('reports unknown tokens', () => {
    const r = validateTemplate('{date}_{bogus}_{nope}');
    expect(r.ok).toBe(false);
    expect(r.unknownTokens).toEqual(['{bogus}', '{nope}']);
  });

  it('recognizes every token exported in FILENAME_TOKENS', () => {
    const all = FILENAME_TOKENS.join('_');
    expect(validateTemplate(all).ok).toBe(true);
  });
});
