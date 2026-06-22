// Rate limiting. The server is otherwise stateless; the ONLY state it keeps is
// these in-memory counter maps (per spec). For a multi-instance deployment swap
// this for Redis — the interface (check/consume/refund) stays the same.
//
//   - max N scans per device per calendar day (default 50)
//   - lifetime soft cap per device (default 5000)
//   - per-IP backstops (device registration + extract)
//   - a GLOBAL daily Gemini-call cap as a billing circuit breaker
import { config } from './config.js';

/**
 * Hard ceiling on counter-map entries so an attacker (or just years of churn)
 * can never grow memory without bound. When full we first sweep entries from
 * previous days, then fall back to evicting the oldest-inserted entries (which
 * can forgive a lifetime count — an accepted tradeoff for a soft cap).
 */
const MAX_COUNTER_ENTRIES = 50_000;

/** deviceId -> { day: 'YYYY-MM-DD', dayCount, lifetimeCount } */
const counters = new Map();

/** "route:ip" -> { day, count } — small per-IP backstop counters. */
const ipCounters = new Map();

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Insert into a counter map, evicting as needed to stay under the ceiling. */
function boundedSet(map, key, value) {
  if (!map.has(key) && map.size >= MAX_COUNTER_ENTRIES) {
    const d = today();
    // Prefer dropping stale-day entries (their daily count is moot anyway).
    for (const [k, v] of map) {
      if (v.day !== d) map.delete(k);
      if (map.size < MAX_COUNTER_ENTRIES) break;
    }
    // Still full (everything is from today): evict oldest-inserted.
    while (map.size >= MAX_COUNTER_ENTRIES) {
      map.delete(map.keys().next().value);
    }
  }
  map.set(key, value);
}

export function checkAndConsume(deviceId) {
  if (!deviceId) {
    return { ok: false, reason: 'missing_device_id', status: 400 };
  }
  const d = today();
  let c = counters.get(deviceId);
  if (!c) {
    c = { day: d, dayCount: 0, lifetimeCount: 0 };
    boundedSet(counters, deviceId, c);
  }
  if (c.day !== d) {
    c.day = d;
    c.dayCount = 0;
  }

  if (c.lifetimeCount >= config.rateLimit.lifetimeSoftCap) {
    return {
      ok: false,
      reason: 'lifetime_cap',
      status: 429,
      message: `Lifetime scan limit (${config.rateLimit.lifetimeSoftCap}) reached for this device.`,
    };
  }
  if (c.dayCount >= config.rateLimit.perDayPerDevice) {
    return {
      ok: false,
      reason: 'daily_cap',
      status: 429,
      message: `Daily scan limit (${config.rateLimit.perDayPerDevice}) reached. Try again tomorrow.`,
    };
  }

  c.dayCount += 1;
  c.lifetimeCount += 1;
  return {
    ok: true,
    remainingToday: config.rateLimit.perDayPerDevice - c.dayCount,
    lifetimeRemaining: config.rateLimit.lifetimeSoftCap - c.lifetimeCount,
  };
}

/**
 * Give back one consumed scan. Used when Gemini fails with a 5xx/timeout —
 * the user got nothing, so they shouldn't be billed a scan for it.
 */
export function refund(deviceId) {
  const c = counters.get(deviceId);
  if (!c) return;
  if (c.day === today() && c.dayCount > 0) c.dayCount -= 1;
  if (c.lifetimeCount > 0) c.lifetimeCount -= 1;
}

export function peek(deviceId) {
  const c = counters.get(deviceId);
  const d = today();
  if (!c || c.day !== d) {
    return {
      remainingToday: config.rateLimit.perDayPerDevice,
      lifetimeRemaining:
        config.rateLimit.lifetimeSoftCap - (c?.lifetimeCount ?? 0),
    };
  }
  return {
    remainingToday: config.rateLimit.perDayPerDevice - c.dayCount,
    lifetimeRemaining: config.rateLimit.lifetimeSoftCap - c.lifetimeCount,
  };
}

// ---------------------------------------------------------------------------
// Per-IP backstop (registration abuse / leaked device-id abuse)
// ---------------------------------------------------------------------------

/**
 * Consume one call from a per-IP daily bucket. `route` namespaces the bucket
 * (e.g. 'register', 'extract'). Requires `app.set('trust proxy', 1)` so
 * `req.ip` is the real client behind Render's proxy.
 */
export function ipCheckAndConsume(ip, route, perDay) {
  const key = `${route}:${ip || 'unknown'}`;
  const d = today();
  let c = ipCounters.get(key);
  if (!c || c.day !== d) {
    c = { day: d, count: 0 };
    boundedSet(ipCounters, key, c);
  }
  if (c.count >= perDay) {
    return {
      ok: false,
      reason: 'ip_daily_cap',
      status: 429,
      message: `Daily per-IP limit (${perDay}) reached for this endpoint. Try again tomorrow.`,
    };
  }
  c.count += 1;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Global daily Gemini cap (billing circuit breaker)
// ---------------------------------------------------------------------------

let globalCounter = { day: today(), count: 0 };

/** Consume one Gemini call from the service-wide daily budget. */
export function globalCheckAndConsume() {
  const d = today();
  if (globalCounter.day !== d) globalCounter = { day: d, count: 0 };
  if (globalCounter.count >= config.rateLimit.globalDailyGeminiCap) {
    return {
      ok: false,
      reason: 'global_daily_cap',
      status: 429,
      message: 'The service-wide daily AI budget is exhausted. Try again tomorrow.',
    };
  }
  globalCounter.count += 1;
  return { ok: true };
}

/** Return an unused global slot (paired with refund() on Gemini 5xx/timeout). */
export function globalRefund() {
  if (globalCounter.day === today() && globalCounter.count > 0) {
    globalCounter.count -= 1;
  }
}

// Test/maintenance helper.
export function _reset() {
  counters.clear();
  ipCounters.clear();
  globalCounter = { day: today(), count: 0 };
}
