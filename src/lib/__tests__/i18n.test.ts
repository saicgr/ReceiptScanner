/**
 * Unit tests for src/lib/i18n.ts — the tiny localization layer (TASK 59).
 * Covers catalog lookup, English fallback, key fallback, interpolation, and the
 * active-language wrapper (setLanguage/t).
 */
import {
  EN,
  translate,
  t,
  setLanguage,
  getLanguage,
  SUPPORTED_LANGUAGES,
  LANGUAGE_NAMES,
} from '../i18n';

describe('translate', () => {
  it('returns the English string for a known key', () => {
    expect(translate('en', 'common.save')).toBe('Save');
  });

  it('falls back to English when the target catalog lacks the key', () => {
    // Spanish catalog is empty (scaffolding) -> English value.
    expect(translate('es', 'common.cancel')).toBe('Cancel');
  });

  it('falls back to the key itself when no catalog has it', () => {
    expect(translate('en', 'totally.unknown.key')).toBe('totally.unknown.key');
  });

  it('interpolates {placeholder} params', () => {
    // Use a synthetic template via a known interpolating path: add to EN at runtime.
    EN['test.greeting'] = 'Hello {name}, you have {count} receipts';
    expect(
      translate('en', 'test.greeting', { name: 'Sam', count: 3 }),
    ).toBe('Hello Sam, you have 3 receipts');
    delete EN['test.greeting'];
  });

  it('leaves unknown placeholders intact', () => {
    EN['test.partial'] = 'Hi {name} {missing}';
    expect(translate('en', 'test.partial', { name: 'A' })).toBe('Hi A {missing}');
    delete EN['test.partial'];
  });
});

describe('active language wrapper', () => {
  afterEach(() => setLanguage('en'));

  it('defaults to English', () => {
    setLanguage('en');
    expect(getLanguage()).toBe('en');
    expect(t('common.done')).toBe('Done');
  });

  it('setLanguage switches the active catalog (with English fallback)', () => {
    setLanguage('fr');
    expect(getLanguage()).toBe('fr');
    // French catalog empty -> English fallback.
    expect(t('common.add')).toBe('Add');
  });

  it('ignores an unsupported language and stays English', () => {
    setLanguage('zz' as never);
    expect(getLanguage()).toBe('en');
  });
});

describe('metadata', () => {
  it('exposes a name for every supported language', () => {
    for (const code of SUPPORTED_LANGUAGES) {
      expect(typeof LANGUAGE_NAMES[code]).toBe('string');
      expect(LANGUAGE_NAMES[code].length).toBeGreaterThan(0);
    }
  });
});
