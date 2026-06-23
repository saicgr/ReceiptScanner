/**
 * Roadmap & feature-request client — talks to the proxy's `/roadmap`,
 * `/roadmap/:id/vote` and `/feature-requests` endpoints.
 *
 * Reuses the device-token auth from extractClient (`authedFetch`) so every call
 * carries `X-Device-Id` + `X-Device-Token`. `fetchRoadmap()` is resilient: it
 * caches the last good response in the settings KV store and, when the backend
 * is unreachable, returns that cache (or the bundled snapshot) so the screen is
 * never blank. Voting/submitting surface failures to the caller so the UI can
 * tell the user the action didn't go through.
 */
import { appConfig } from '@/lib/config';
import { authedFetch } from '@/services/extractClient';
import { getSetting, setSetting } from '@/db/settings';
import { BUNDLED_ROADMAP, type RoadmapItem, type RoadmapStatus } from '@/data/roadmap';

export type { RoadmapItem, RoadmapStatus };

/** Abort roadmap reads/writes after this long; we'd rather fall back than hang. */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Settings-DB key for the cached roadmap payload. The settings table is a plain
 * key/value store; this key is app-internal plumbing (not user-facing), so it
 * intentionally isn't part of the typed AppSettings shape — hence the untyped
 * call wrappers below (mirrors how extractClient stores `device_token`).
 */
const ROADMAP_CACHE_KEY = 'roadmap_cache';
const getStoredSetting = getSetting as unknown as (key: string) => Promise<unknown>;
const setStoredSetting = setSetting as unknown as (key: string, value: unknown) => Promise<void>;

const VALID_STATUS = new Set<RoadmapStatus>(['in_progress', 'planned', 'shipped']);

/** Coerce an unknown payload item into a strict RoadmapItem (defensive). */
function normalizeItem(raw: unknown): RoadmapItem | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  const title = typeof r.title === 'string' ? r.title : '';
  if (!id || !title) return null;
  const status = (VALID_STATUS.has(r.status as RoadmapStatus) ? r.status : 'planned') as RoadmapStatus;
  const upvotes = typeof r.upvotes === 'number' && Number.isFinite(r.upvotes) ? Math.max(0, Math.round(r.upvotes)) : 0;
  return {
    id,
    title,
    description: typeof r.description === 'string' ? r.description : '',
    status,
    category: typeof r.category === 'string' ? r.category : null,
    upvotes,
    voted: Boolean(r.voted),
  };
}

function normalizeItems(raw: unknown): RoadmapItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeItem).filter((x): x is RoadmapItem => x !== null);
}

/** The result of a roadmap load: the items plus whether they're live or cached. */
export interface RoadmapResult {
  items: RoadmapItem[];
  /** True when the items came from the network (votes are current). */
  online: boolean;
}

/**
 * Fetch the roadmap. Always resolves — never throws. On success caches the
 * payload and returns `{ online: true }`. On failure returns the cached payload
 * (or the bundled snapshot) with `{ online: false }` so the screen can disable
 * voting and show an offline notice.
 */
export async function fetchRoadmap(): Promise<RoadmapResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await authedFetch(`${appConfig.apiBaseUrl}/roadmap`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`roadmap failed: HTTP ${res.status}`);
    const json = (await res.json()) as { items?: unknown };
    const items = normalizeItems(json.items);
    if (items.length === 0) throw new Error('roadmap returned no items');
    // Best-effort cache for the next offline open.
    try {
      await setStoredSetting(ROADMAP_CACHE_KEY, items);
    } catch {
      /* cache is best-effort */
    }
    return { items, online: true };
  } catch (err) {
    if (__DEV__) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[roadmapClient] ${reason}; using cached/bundled roadmap`);
    }
    return { items: await cachedOrBundled(), online: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Last cached payload, else the compiled-in bundled snapshot. */
async function cachedOrBundled(): Promise<RoadmapItem[]> {
  try {
    const cached = normalizeItems(await getStoredSetting(ROADMAP_CACHE_KEY));
    if (cached.length > 0) return cached;
  } catch {
    /* settings DB not ready — fall through to bundled */
  }
  return BUNDLED_ROADMAP;
}

/**
 * Toggle this device's upvote on a roadmap item. Resolves with the fresh state
 * on success; throws with a user-facing message on failure (rate limit, storage
 * down, offline) so the screen can revert its optimistic update and alert.
 */
export async function toggleRoadmapVote(
  id: string,
): Promise<{ id: string; voted: boolean; upvotes: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await authedFetch(`${appConfig.apiBaseUrl}/roadmap/${encodeURIComponent(id)}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      voted?: boolean;
      upvotes?: number;
      message?: string;
    };
    if (!res.ok) {
      throw new Error(json.message || `Couldn't record your vote (HTTP ${res.status}).`);
    }
    return { id, voted: Boolean(json.voted), upvotes: typeof json.upvotes === 'number' ? json.upvotes : 0 };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Voting timed out. Check your connection and try again.');
    }
    throw err instanceof Error ? err : new Error('Could not record your vote.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Submit a private feature request. Resolves `{ id }` on success; throws with a
 * user-facing message on failure (validation, rate limit, storage down, offline).
 */
export async function submitFeatureRequest(args: {
  title: string;
  description: string;
  category?: string | null;
}): Promise<{ id: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await authedFetch(`${appConfig.apiBaseUrl}/feature-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: args.title,
        description: args.description,
        category: args.category ?? undefined,
      }),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      id?: string;
      message?: string;
    };
    if (!res.ok || !json.ok) {
      throw new Error(json.message || `Couldn't submit your request (HTTP ${res.status}).`);
    }
    return { id: json.id ?? '' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out. Check your connection and try again.');
    }
    throw err instanceof Error ? err : new Error('Could not submit your request.');
  } finally {
    clearTimeout(timer);
  }
}
