/**
 * Extraction client — the bridge between on-device OCR and the Gemini-backed
 * `/extract` proxy.
 *
 * Flow (see docs/AGENT_CONTRACTS.md):
 *   1. Read the captured image to base64 (expo-file-system).
 *   2. POST { ocrText, imageBase64, imageMimeType, preferredDateFormat } to the
 *      backend, authenticating the device via the `X-Device-Id` header so the
 *      server can enforce its per-device rate limits.
 *   3. The server returns Gemini's structured JSON (already normalized to the
 *      ExtractionResult contract). We harden it once more on the client so a
 *      malformed/old response can never crash the review screen.
 *   4. On ANY network failure (offline, timeout, 5xx, abuse cap) we degrade
 *      gracefully to a purely local, regex-based heuristic so the user can still
 *      review and edit a draft — accuracy is lower, confidence is reported as
 *      'low', and dates are run through the shared `disambiguate()` so the
 *      ambiguity UX still works offline.
 *
 * Nothing here is ever auto-finalized; this only produces an editable draft.
 */
import * as FileSystem from 'expo-file-system/legacy';

import { appConfig } from '@/lib/config';
import { getDeviceId } from '@/lib/device';
import { disambiguate } from '@/lib/dates';
import { extractCacheKey } from '@/lib/extractCacheKey';
import { getCachedExtraction, setCachedExtraction } from './extractCache';
import { getSetting, setSetting } from '@/db/settings';
import { listCategories } from '@/db/categories';
import type {
  Confidence,
  ExtractedLineItem,
  ExtractionResult,
  FieldConfidence,
} from '@/types';

/** Abort the network call after this long; we'd rather fall back than hang. */
const REQUEST_TIMEOUT_MS = 35000;

// ---------------------------------------------------------------------------
// Small coercion helpers (mirror the server's `normalize()` so the client and
// the offline fallback always emit the exact same ExtractionResult shape).
// ---------------------------------------------------------------------------

/** Clamp an unknown confidence into the allowed bucket, defaulting to 'low'. */
function asConfidence(value: unknown): Confidence {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : 'low';
}

/** Parse a possibly-stringy money value (e.g. "$12.99") into a number or null. */
function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n =
    typeof value === 'number'
      ? value
      : parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Map the user's preferred display format onto disambiguate()'s order codes. */
function preferredDateOrder(dateFormat: string): 'MDY' | 'DMY' | 'YMD' {
  const f = (dateFormat || '').toUpperCase();
  // Year-first formats (e.g. "YYYY-MM-DD", "YYYY/MM/DD").
  if (/^Y{2,4}/.test(f)) return 'YMD';
  // Day-first formats (e.g. "DD/MM/YYYY", "D-M-YY").
  const dIndex = f.indexOf('D');
  const mIndex = f.indexOf('M');
  if (dIndex >= 0 && mIndex >= 0 && dIndex < mIndex) return 'DMY';
  // Default to month-first (US style).
  return 'MDY';
}

/**
 * Build a fully-populated FieldConfidence, inheriting the date confidence for
 * vendor/date when the server omitted per-field detail (matches server logic).
 */
function buildFieldConfidence(
  partial: Partial<FieldConfidence> | undefined,
  fallbackDateConfidence: Confidence,
): FieldConfidence {
  return {
    vendor: asConfidence(partial?.vendor ?? fallbackDateConfidence),
    date: asConfidence(partial?.date ?? fallbackDateConfidence),
    total: asConfidence(partial?.total),
    tax: asConfidence(partial?.tax),
  };
}

/**
 * Coerce an arbitrary server/legacy payload into a strict ExtractionResult with
 * safe defaults. Defensive against missing/extra/malformed fields so the review
 * screen always receives something renderable.
 */
function normalizeResult(raw: unknown): ExtractionResult {
  const r = (raw ?? {}) as Record<string, unknown>;

  const dateConfidence = asConfidence(r.date_confidence);

  const rawDate = typeof r.date === 'string' && r.date.trim() ? r.date.trim() : null;
  const options = Array.isArray(r.date_options)
    ? [
        ...new Set(
          r.date_options
            .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
            .map((d) => d.trim()),
        ),
      ]
    : [];
  // Ambiguity is only "real" when more than one interpretation survives.
  const dateAmbiguous = Boolean(r.date_ambiguous) && options.length > 1;

  const rawItems = Array.isArray(r.line_items) ? r.line_items : [];
  const line_items: ExtractedLineItem[] = rawItems.map((li) => {
    const item = (li ?? {}) as Record<string, unknown>;
    return {
      name: typeof item.name === 'string' ? item.name.trim() : '',
      qty: asNumberOrNull(item.qty) ?? 1,
      price: asNumberOrNull(item.price) ?? 0,
      return_window_days: asNumberOrNull(item.return_window_days),
      warranty_period_days: asNumberOrNull(item.warranty_period_days),
    };
  });

  return {
    vendor: typeof r.vendor === 'string' ? r.vendor.trim() : '',
    date: rawDate,
    date_confidence: dateConfidence,
    date_ambiguous: dateAmbiguous,
    date_options: options.length ? options : rawDate ? [rawDate] : [],
    total: asNumberOrNull(r.total) ?? 0,
    tax: asNumberOrNull(r.tax),
    currency:
      typeof r.currency === 'string' && r.currency.trim()
        ? r.currency.trim().toUpperCase()
        : 'USD',
    line_items,
    field_confidence: buildFieldConfidence(
      r.field_confidence as Partial<FieldConfidence> | undefined,
      dateConfidence,
    ),
    // ---- V2 (backward compatible: absent on V1 responses) ----
    return_window_days: asNumberOrNull(r.return_window_days),
    warranty_period_days: asNumberOrNull(r.warranty_period_days),
    category: typeof r.category === 'string' && r.category.trim() ? r.category.trim() : null,
    tax_category: typeof r.tax_category === 'string' ? r.tax_category : null,
    is_deductible:
      r.is_deductible === null || r.is_deductible === undefined
        ? null
        : Boolean(r.is_deductible),
    deductible_percent: asNumberOrNull(r.deductible_percent),
    // ---- V3 ----
    condition: Array.isArray(r.condition)
      ? (r.condition.filter(
          (c): c is string => typeof c === 'string' && CONDITION_VOCAB.has(c),
        ) as ExtractionResult['condition'])
      : [],
  };
}

const CONDITION_VOCAB = new Set<string>([
  'torn', 'folded', 'crumpled', 'faded', 'blurry', 'partial', 'long', 'handwritten', 'thermal', 'digital',
]);

// ---------------------------------------------------------------------------
// Device-token auth
//
// The server no longer trusts a bare X-Device-Id (it was spoofable, letting an
// abuser rotate ids past the rate limits). The device registers ONCE via
// POST /device/register and from then on presents X-Device-Token =
// HMAC-SHA256(deviceId, server secret) on every proxy call. The token is
// persisted in the settings DB; a 401 triggers a transparent re-registration
// (e.g. after a server secret rotation). All of this is best-effort — when the
// server is unreachable the callers fall back to their offline paths.
// ---------------------------------------------------------------------------

/**
 * Settings-DB key for the registered device token. The settings table is a
 * plain key/value store; this key is app-internal plumbing (not user-facing),
 * so it intentionally isn't part of the typed AppSettings shape — hence the
 * untyped call wrappers below.
 */
const DEVICE_TOKEN_KEY = 'device_token';
const getStoredSetting = getSetting as unknown as (key: string) => Promise<unknown>;
const setStoredSetting = setSetting as unknown as (key: string, value: unknown) => Promise<void>;

/** In-memory cache so we hit the settings DB once per app session. */
let cachedDeviceToken: string | null = null;

/** Timeout for the (tiny) registration round-trip. */
const REGISTER_TIMEOUT_MS = 12_000;

/** POST /device/register → the token for this deviceId, or null on failure. */
async function registerDevice(deviceId: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);
  try {
    const res = await fetch(`${appConfig.apiBaseUrl}/device/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { deviceToken?: string };
    return typeof data.deviceToken === 'string' && data.deviceToken
      ? data.deviceToken
      : null;
  } catch {
    // Offline / server down — callers proceed without a token and degrade.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the device token: memory cache → settings DB → fresh registration.
 * `forceRegister` skips the caches (used after a 401). Returns null when the
 * backend is unreachable — never throws.
 */
export async function getDeviceToken(forceRegister = false): Promise<string | null> {
  if (!forceRegister) {
    if (cachedDeviceToken) return cachedDeviceToken;
    try {
      const stored = await getStoredSetting(DEVICE_TOKEN_KEY);
      if (typeof stored === 'string' && stored) {
        cachedDeviceToken = stored;
        return stored;
      }
    } catch {
      // Settings DB not ready — fall through to registration.
    }
  }
  const deviceId = await getDeviceId();
  const token = await registerDevice(deviceId);
  if (token) {
    cachedDeviceToken = token;
    try {
      await setStoredSetting(DEVICE_TOKEN_KEY, token);
    } catch {
      // Persisting is best-effort; the in-memory cache covers this session.
    }
  }
  return token;
}

/**
 * The auth headers every proxy call must carry. When registration failed we
 * still send the device id alone — the server will 401 and `authedFetch`'s
 * retry (or the caller's offline fallback) takes it from there.
 */
export async function getDeviceAuthHeaders(
  forceRegister = false,
): Promise<Record<string, string>> {
  const deviceId = await getDeviceId();
  const token = await getDeviceToken(forceRegister);
  return token
    ? { 'X-Device-Id': deviceId, 'X-Device-Token': token }
    : { 'X-Device-Id': deviceId };
}

/**
 * fetch() with the device auth headers attached, transparently re-registering
 * and retrying ONCE on 401 (stale/missing token). Network errors propagate so
 * each caller keeps its own offline-fallback behavior.
 */
export async function authedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const baseHeaders = (init.headers ?? {}) as Record<string, string>;
  let res = await fetch(url, {
    ...init,
    headers: { ...baseHeaders, ...(await getDeviceAuthHeaders()) },
  });
  if (res.status === 401) {
    res = await fetch(url, {
      ...init,
      headers: { ...baseHeaders, ...(await getDeviceAuthHeaders(true)) },
    });
  }
  return res;
}

// ---------------------------------------------------------------------------
// Image I/O
// ---------------------------------------------------------------------------

/** Read a local image uri into a base64 string; null when it can't be read. */
async function readImageBase64(uri: string): Promise<string | null> {
  try {
    return await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch {
    // File missing / web / permission — proceed with OCR text only.
    return null;
  }
}

/** Best-effort mime type from a file extension; defaults to JPEG. */
function guessMimeType(uri: string, explicit?: string): string {
  if (explicit) return explicit;
  const lower = uri.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.heic') || lower.endsWith('.heif')) return 'image/heic';
  return 'image/jpeg';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract structured receipt data from an image and/or OCR text.
 *
 * Always resolves with an ExtractionResult — it never rejects. When the backend
 * is unreachable (or returns an error), it transparently falls back to
 * `localExtractFallback(ocrText)` so the user can still review a draft offline.
 */
export async function extractReceipt(args: {
  imageUri?: string;
  /** Pre-read base64 — lets the caller encode IN PARALLEL with OCR. */
  imageBase64?: string | null;
  ocrText?: string;
  imageMimeType?: string;
  /** Spending-category names for the model to choose from; auto-loaded if omitted. */
  categoryHints?: string[];
}): Promise<ExtractionResult> {
  const { imageUri, ocrText = '', imageMimeType } = args;

  // Read the user's preferred date format so the server can order ambiguous
  // interpretations (and so our offline fallback matches that ordering).
  let preferredDateFormat = 'MM/DD/YYYY';
  try {
    preferredDateFormat = await getSetting('date_format');
  } catch {
    // Settings DB not ready — the default is fine.
  }

  // Prefer the caller's pre-read base64 (encoded in parallel with OCR); only
  // read from disk here if it wasn't supplied. mimeType respects an explicit
  // override (e.g. 'application/pdf') and otherwise is guessed from the uri.
  let imageBase64: string | null = args.imageBase64 ?? null;
  let mimeType: string | undefined = imageMimeType;
  if (!imageBase64 && imageUri) {
    imageBase64 = await readImageBase64(imageUri);
  }
  if (imageUri && !imageMimeType) {
    mimeType = guessMimeType(imageUri, imageMimeType);
  }

  // Give the model the user's category list so receipts arrive pre-categorized
  // (the user can always change it on the review screen).
  let categoryHints = args.categoryHints;
  if (!categoryHints) {
    try {
      categoryHints = (await listCategories()).map((c) => c.name);
    } catch {
      categoryHints = undefined;
    }
  }

  // If we have neither text nor an image, there's nothing to send — return an
  // empty, fully-editable draft rather than calling the backend for nothing.
  if (!ocrText.trim() && !imageBase64) {
    if (__DEV__) {
      console.warn(
        '[extractClient] no OCR text AND no image base64 — skipping /extract and ' +
          'returning an empty draft. The image likely failed to encode (e.g. ' +
          'toBase64 returned "" for this uri). The "couldn\'t read much" screen ' +
          'comes from here, not the server.',
      );
    }
    return localExtractFallback(ocrText);
  }

  // Extraction cache (TASK 33): re-scanning the SAME receipt should not re-pay
  // for a Gemini call. The key is a stable fingerprint of everything that can
  // change the output (image bytes + OCR text + mime + date format + hints). A
  // hit short-circuits the network round-trip AND the server-side scan budget.
  const cacheKey = extractCacheKey({
    imageBase64,
    ocrText,
    imageMimeType: mimeType,
    preferredDateFormat,
    categoryHints,
  });
  const cached = await getCachedExtraction(cacheKey);
  if (cached) {
    if (__DEV__) console.log('[extractClient] cache hit; skipping /extract');
    return cached;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    // authedFetch attaches X-Device-Id + X-Device-Token (registering on first
    // use) and retries once on 401; any failure still lands in the fallback.
    const response = await authedFetch(`${appConfig.apiBaseUrl}/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ocrText,
        imageBase64,
        imageMimeType: mimeType,
        preferredDateFormat,
        categoryHints,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Rate-limit / server error / abuse cap. Read the message for logging,
      // then fall back locally so the user is never blocked.
      let message = `extract failed: HTTP ${response.status}`;
      try {
        const errBody = (await response.json()) as { message?: string };
        if (errBody?.message) message = errBody.message;
      } catch {
        // non-JSON body — keep the generic message
      }
      if (__DEV__) console.warn(`[extractClient] ${message}; using local fallback`);
      return localExtractFallback(ocrText);
    }

    const json = (await response.json()) as unknown;
    const result = normalizeResult(json);
    // Cache only REAL proxy results (never the offline heuristic) so an
    // identical re-scan is free next time. Best-effort, fire-and-forget.
    void setCachedExtraction(cacheKey, result);
    return result;
  } catch (err) {
    // Network down, DNS failure, timeout/abort, or JSON parse error.
    if (__DEV__) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[extractClient] network error (${reason}); using local fallback`);
    }
    return localExtractFallback(ocrText);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Offline fallback
// ---------------------------------------------------------------------------

/** Currency symbol → ISO 4217 code, for the offline currency guess. */
const CURRENCY_SYMBOLS: { symbol: string; code: string }[] = [
  { symbol: '$', code: 'USD' },
  { symbol: '£', code: 'GBP' },
  { symbol: '€', code: 'EUR' },
  { symbol: '¥', code: 'JPY' },
  { symbol: '₹', code: 'INR' },
  { symbol: '₩', code: 'KRW' },
  { symbol: '₺', code: 'TRY' },
  { symbol: 'R$', code: 'BRL' },
];

/** Three-letter ISO codes we'll happily recognize if printed literally. */
const ISO_CODE_RE =
  /\b(USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|KRW|MXN|BRL|SEK|NOK|DKK|NZD|SGD|HKD|ZAR|TRY|AED)\b/;

/** Keywords that mark the grand-total line on most receipts. */
const TOTAL_KEYWORDS =
  /\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|total)\b/i;

/** Pull the first plausible monetary number out of a single line. */
function parseAmount(line: string): number | null {
  // Prefer the LAST money-looking token on the line (totals sit at the right).
  const matches = line.match(/-?\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{2})|-?\d+[.,]\d{2}|-?\d+/g);
  if (!matches || matches.length === 0) return null;
  const raw = matches[matches.length - 1];
  // Normalize: strip thousands separators, treat a trailing comma as a decimal.
  let cleaned = raw.replace(/\s/g, '');
  if (/,\d{2}$/.test(cleaned) && !/\.\d/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    cleaned = cleaned.replace(/,/g, '');
  }
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Best-effort, fully on-device extraction from raw OCR text. Used when the
 * backend is unreachable. Everything is reported with LOW confidence so the
 * review screen prompts the user to double-check. Line items are intentionally
 * left empty (reliable line-item parsing needs the model); the user can add
 * them manually. Any date found is run through the shared `disambiguate()` so
 * the ambiguity-resolution UX still works offline.
 */
export function localExtractFallback(ocrText: string): ExtractionResult {
  const text = ocrText ?? '';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // ---- Vendor: first non-empty, non-numeric-looking line ----
  let vendor = '';
  for (const line of lines) {
    // Skip lines that are mostly digits/punctuation (receipt headers, dates).
    const letters = line.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 2 && !/^\d/.test(line)) {
      vendor = line;
      break;
    }
  }
  if (!vendor && lines.length > 0) vendor = lines[0];

  // ---- Currency guess: explicit ISO code first, then symbol ----
  let currency = 'USD';
  const isoMatch = text.toUpperCase().match(ISO_CODE_RE);
  if (isoMatch) {
    currency = isoMatch[1];
  } else {
    for (const { symbol, code } of CURRENCY_SYMBOLS) {
      if (text.includes(symbol)) {
        currency = code;
        break;
      }
    }
  }

  // ---- Total: prefer a line flagged "total", else the largest amount ----
  let total = 0;
  const totalLines = lines.filter((l) => TOTAL_KEYWORDS.test(l));
  // Prefer the most specific "grand total"/"total due" line if present.
  const orderedTotalLines = [
    ...totalLines.filter((l) => /grand|due|balance/i.test(l)),
    ...totalLines.filter((l) => !/grand|due|balance/i.test(l)),
  ];
  for (const line of orderedTotalLines) {
    const amt = parseAmount(line);
    if (amt != null && amt > 0) {
      total = amt;
      break;
    }
  }
  if (total === 0) {
    // No "total" keyword matched — fall back to the largest amount on the receipt.
    let max = 0;
    for (const line of lines) {
      const amt = parseAmount(line);
      if (amt != null && amt > max) max = amt;
    }
    total = max;
  }

  // ---- Tax: a line mentioning tax / VAT / GST ----
  let tax: number | null = null;
  for (const line of lines) {
    if (/\b(tax|vat|gst|hst|pst)\b/i.test(line)) {
      const amt = parseAmount(line);
      if (amt != null && amt >= 0) {
        tax = amt;
        break;
      }
    }
  }

  // ---- Date: find the first date-looking token and disambiguate it ----
  let date: string | null = null;
  let dateAmbiguous = false;
  let dateOptions: string[] = [];
  const dateMatch = text.match(/\b(\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4})\b/);
  if (dateMatch) {
    const { date: iso, ambiguous, options } = disambiguate(dateMatch[1], 'MDY');
    date = iso;
    dateAmbiguous = ambiguous;
    dateOptions = options;
  }

  return {
    vendor,
    date,
    date_confidence: 'low',
    date_ambiguous: dateAmbiguous,
    date_options: dateOptions,
    total,
    tax,
    currency,
    line_items: [], // line items require the model; user can add them manually.
    field_confidence: {
      vendor: 'low',
      date: 'low',
      total: 'low',
      tax: 'low',
    },
    // V2 fields can't be inferred reliably offline.
    return_window_days: null,
    warranty_period_days: null,
    tax_category: null,
    is_deductible: null,
    deductible_percent: null,
  };
}
