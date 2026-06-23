/**
 * i18n — a tiny, dependency-free localization layer (TASK 59, scaffolding).
 *
 * This is intentionally minimal: a single English catalog, a `t()` lookup with
 * `{placeholder}` interpolation and a graceful fallback, plus a settable active
 * language. The whole app is NOT translated — only a few representative strings
 * are wired through `t()` to prove the plumbing. Adding a real language later is
 * just dropping another catalog into CATALOGS and translating the keys.
 *
 * Pure / unit-testable: the catalog and `translate()` take their inputs
 * explicitly; `t()` is the convenience wrapper that reads the module-level
 * active language (set from the settings store on load / language change).
 */
import type { LanguageCode } from '../types';

/** The canonical English catalog. Keys are dotted, namespaced by screen/area. */
export const EN: Record<string, string> = {
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.done': 'Done',
  'common.add': 'Add',

  'settings.title': 'Settings',
  'settings.language': 'Language',
  'settings.language.subtitle': 'Choose the app language',
  'settings.reports': 'Export columns',
  'settings.reports.subtitle': 'Choose, reorder and lay out report columns',
  'settings.voice': 'Voice input',
  'settings.voice.subtitle': 'Speak prompts aloud for hands-free entry',
  'settings.aiSummary': 'AI receipt summary',
  'settings.aiSummary.subtitle': 'One-line summary via the cloud (opt-in)',

  'review.vendor': 'Vendor',
  'review.date': 'Date',
  'review.total': 'Total',
  'review.account': 'Account / card',
  'review.account.placeholder': 'e.g. Amex Gold',
  'review.account.last4': 'Last 4 digits',
  'review.saveReceipt': 'Save receipt',
  'review.discard': 'Discard',

  'receipt.receivedViaEmail': 'Received via email',
  'receipt.summary': 'Summary',
  'receipt.summary.generate': 'Generate AI summary',
  'receipt.summary.offline': 'Connect to the internet to generate a summary.',

  'history.title': 'Receipts',
};

/** Language code → catalog. English is the only complete one (scaffolding). */
export const CATALOGS: Record<LanguageCode, Record<string, string>> = {
  en: EN,
  // Stub catalogs: empty so every key falls back to English. Translating later
  // means filling these in — no other code changes required.
  es: {},
  fr: {},
  de: {},
};

/** Human-readable language names for the picker (always in their own language). */
export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
};

export const SUPPORTED_LANGUAGES: LanguageCode[] = ['en', 'es', 'fr', 'de'];

/** Substitute `{name}` placeholders from a params object. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

/**
 * Pure translation: look up `key` in `lang`'s catalog, falling back to English,
 * then to the key itself, then interpolate `{placeholders}`. Exported so it can
 * be unit-tested without touching module state.
 */
export function translate(
  lang: LanguageCode,
  key: string,
  params?: Record<string, string | number>,
): string {
  const catalog = CATALOGS[lang] ?? EN;
  const template = catalog[key] ?? EN[key] ?? key;
  return interpolate(template, params);
}

// ---------------------------------------------------------------------------
// Active-language convenience wrapper
// ---------------------------------------------------------------------------

let activeLanguage: LanguageCode = 'en';

/** Set the active UI language (called from the settings store). */
export function setLanguage(lang: LanguageCode): void {
  activeLanguage = SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en';
}

/** The current active language. */
export function getLanguage(): LanguageCode {
  return activeLanguage;
}

/** Translate `key` in the active language with optional `{placeholder}` params. */
export function t(key: string, params?: Record<string, string | number>): string {
  return translate(activeLanguage, key, params);
}
