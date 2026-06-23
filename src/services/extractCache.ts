/**
 * Client-side extraction cache (TASK 33).
 *
 * Primary defense against re-paying for identical re-scans: before calling the
 * `/extract` proxy, the client checks a small persistent cache keyed by a stable
 * fingerprint of the request (see `extractCacheKey`). A hit short-circuits the
 * whole round-trip — no network, no device-scan counter, no Gemini budget — and
 * returns the previously-extracted draft instantly.
 *
 * Storage: a single AsyncStorage entry holding a bounded, LRU-ordered map of
 * `{ key -> { result, at } }`. We keep it tiny and self-trimming so it can never
 * grow without bound:
 *   - at most {@link MAX_ENTRIES} entries (oldest-used evicted first),
 *   - entries older than {@link TTL_MS} are ignored on read and dropped on write.
 *
 * This is best-effort and entirely local: any storage failure degrades to "no
 * cache" (the request just proceeds to the proxy). It never throws.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ExtractionResult } from '@/types';

/** One AsyncStorage row holds the entire cache map. */
const STORAGE_KEY = 'extract_cache_v1';

/** Cap on cached results — extraction results are small JSON, but bound anyway. */
const MAX_ENTRIES = 100;

/** Entries older than this are treated as stale (30 days). */
const TTL_MS = 30 * 24 * 3600 * 1000;

interface CacheEntry {
  result: ExtractionResult;
  /** Epoch ms the entry was last written/refreshed (LRU + TTL ordering). */
  at: number;
}

type CacheMap = Record<string, CacheEntry>;

/** In-memory mirror so repeated lookups in one session avoid disk reads. */
let memo: CacheMap | null = null;

async function loadMap(): Promise<CacheMap> {
  if (memo) return memo;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    memo = raw ? (JSON.parse(raw) as CacheMap) : {};
  } catch {
    memo = {};
  }
  return memo;
}

async function saveMap(map: CacheMap): Promise<void> {
  memo = map;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Persisting is best-effort; the in-memory mirror still serves this session.
  }
}

/**
 * Return a cached extraction for `key`, or null on miss/stale/error. A hit
 * refreshes the entry's `at` timestamp (LRU touch) best-effort.
 */
export async function getCachedExtraction(
  key: string,
): Promise<ExtractionResult | null> {
  if (!key) return null;
  try {
    const map = await loadMap();
    const entry = map[key];
    if (!entry) return null;
    if (Date.now() - entry.at > TTL_MS) {
      // Stale — drop it so it doesn't linger.
      delete map[key];
      await saveMap(map);
      return null;
    }
    // LRU touch (don't block the caller on the write).
    entry.at = Date.now();
    void saveMap(map);
    return entry.result;
  } catch {
    return null;
  }
}

/**
 * Store an extraction result under `key`, trimming the cache to {@link MAX_ENTRIES}
 * by evicting the least-recently-used entries. Best-effort; never throws.
 */
export async function setCachedExtraction(
  key: string,
  result: ExtractionResult,
): Promise<void> {
  if (!key) return;
  try {
    const map = await loadMap();
    map[key] = { result, at: Date.now() };

    // Evict stale + LRU overflow.
    const now = Date.now();
    let keys = Object.keys(map).filter((k) => now - map[k].at <= TTL_MS);
    // Drop anything that just aged out.
    for (const k of Object.keys(map)) {
      if (!keys.includes(k)) delete map[k];
    }
    if (keys.length > MAX_ENTRIES) {
      keys = keys.sort((a, b) => map[a].at - map[b].at); // oldest first
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
    }
    await saveMap(map);
  } catch {
    // Ignore — caching is an optimization, not correctness.
  }
}

/** Clear the entire cache (used by tests / a "reset" affordance). */
export async function clearExtractCache(): Promise<void> {
  memo = {};
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}
