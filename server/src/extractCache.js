// Server-side extraction cache (TASK 33 — defense-in-depth).
//
// The CLIENT cache is the primary win (it skips the network round-trip too).
// This bounded in-memory LRU is a backstop: when two requests carry identical
// content (the SAME image bytes + OCR text + mime + date format + category
// hints), the second returns the cached extraction WITHOUT calling Gemini and
// WITHOUT consuming the global daily budget — so a retry storm or several
// devices scanning the same e-receipt can't burn the billing circuit breaker.
//
// Strictly bounded: at most MAX_ENTRIES live entries with LRU eviction (a prior
// review flagged unbounded-Map OOM risk), plus a TTL so stale entries expire.
// Keyed by a sha256 of the request so we never hold the raw image bytes as a key.
import { createHash } from 'node:crypto';

/** Hard ceiling on cached extractions. Each value is small JSON. */
const MAX_ENTRIES = 500;

/** Entries older than this are treated as a miss (1 hour). */
const TTL_MS = 60 * 60 * 1000;

/**
 * Insertion-ordered Map used as an LRU: on read we delete+re-set the key to move
 * it to the most-recently-used end; on overflow we evict from the oldest end
 * (Map iteration order is insertion order).
 * key -> { value, at }
 */
const cache = new Map();

/**
 * Derive a stable cache key from the extraction request. Mirrors the client's
 * fingerprint inputs (image bytes, OCR text, mime, date format, category hints
 * as an order-insensitive set) but hashed server-side so the key is compact and
 * never the raw base64. Returns null when there's nothing cacheable.
 */
export function extractRequestKey({
  ocrText,
  imageBase64,
  imageMimeType,
  preferredDateFormat,
  categoryHints,
}) {
  if (!ocrText && !imageBase64) return null;
  const hints = Array.isArray(categoryHints)
    ? [...new Set(categoryHints.map((c) => String(c || '').trim().toLowerCase()))]
        .filter(Boolean)
        .sort()
        .join(',')
    : '';
  const h = createHash('sha256');
  h.update(imageBase64 || '');
  h.update('\x00');
  h.update((ocrText || '').trim());
  h.update('\x00');
  h.update(imageMimeType || '');
  h.update('\x00');
  h.update(String(preferredDateFormat || '').toUpperCase());
  h.update('\x00');
  h.update(hints);
  return h.digest('hex');
}

/** Get a cached extraction (deep-cloned) for `key`, or null on miss/stale. */
export function getCached(key) {
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  // LRU touch: move to the most-recently-used position.
  cache.delete(key);
  cache.set(key, entry);
  // Return a copy so a caller mutating the result (e.g. attaching _meta) can't
  // poison the cached value.
  return structuredClone(entry.value);
}

/** Store an extraction under `key`, evicting stale + LRU-overflow entries. */
export function setCached(key, value) {
  if (!key) return;
  // Refresh position if present.
  cache.delete(key);
  cache.set(key, { value: structuredClone(value), at: Date.now() });
  // Evict oldest entries beyond the ceiling (insertion order == LRU order).
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/** Test/maintenance helper. */
export function _resetExtractCache() {
  cache.clear();
}

/** Exposed for tests/health introspection. */
export function _cacheSize() {
  return cache.size;
}
