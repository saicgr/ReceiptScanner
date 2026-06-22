// Ephemeral per-user pending queue for the email-forwarding feature.
//
// IMPORTANT: We do NOT persistently store user receipts on the server. When a
// receipt arrives by email it is extracted and parked here, keyed by the user's
// forwarding token, ONLY until the app polls (GET /pending) and acknowledges
// (POST /pending/ack). Entries also auto-expire after PENDING_TTL_MS as a
// backstop so nothing lingers. In-memory by design; a single small instance.
//
// Memory bounds (this map used to be unbounded — base64 images held for 72h):
//   - per-item images over MAX_IMAGE_BYTES are dropped (extraction is kept),
//   - each token's queue is capped at MAX_ITEMS_PER_TOKEN (oldest evicted),
//   - total held bytes are capped at MAX_TOTAL_BYTES (globally-oldest evicted).
import { config } from './config.js';
import { randomUUID } from 'node:crypto';

/** Refuse imageBase64 payloads bigger than this (base64 length ≈ held bytes). */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Max queued items per forwarding token; the oldest is evicted beyond this. */
const MAX_ITEMS_PER_TOKEN = 25;
/** Global cap on bytes held across ALL queues; oldest items evicted first. */
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** token -> Array<{ id, extraction, imageBase64?, imageMimeType?, source, receivedAt, bytes }> */
const queues = new Map();
let totalBytes = 0;

/** Approximate in-memory footprint of one entry. */
function entryBytes(entry) {
  return (
    (entry.imageBase64 ? entry.imageBase64.length : 0) +
    JSON.stringify(entry.extraction || null).length
  );
}

export function enqueue(token, item) {
  if (!token) throw new Error('token required');
  const entry = {
    id: randomUUID(),
    receivedAt: Date.now(),
    ...item,
  };
  // Oversized image: keep the extraction (the valuable part), drop the pixels.
  if (entry.imageBase64 && entry.imageBase64.length > MAX_IMAGE_BYTES) {
    console.warn(
      `[pendingStore] dropping oversized image (${entry.imageBase64.length} b64 chars) for token ${token}`,
    );
    entry.imageBase64 = null;
    entry.imageMimeType = null;
  }
  entry.bytes = entryBytes(entry);

  const q = queues.get(token) || [];
  q.push(entry);
  queues.set(token, q);
  totalBytes += entry.bytes;

  // Per-token cap: evict this user's oldest entries beyond the limit.
  while (q.length > MAX_ITEMS_PER_TOKEN) {
    totalBytes -= q.shift().bytes;
  }
  sweep();
  // Global byte cap: evict the globally-oldest entries until under budget.
  while (totalBytes > MAX_TOTAL_BYTES && evictOldest()) {
    /* keep evicting */
  }
  return entry.id;
}

export function list(token) {
  sweep();
  return (queues.get(token) || []).map((e) => ({
    id: e.id,
    extraction: e.extraction,
    imageBase64: e.imageBase64 || null,
    imageMimeType: e.imageMimeType || null,
    source: e.source || 'email',
    receivedAt: new Date(e.receivedAt).toISOString(),
  }));
}

export function ack(token, ids) {
  const q = queues.get(token);
  if (!q) return 0;
  const set = new Set(ids);
  const remaining = q.filter((e) => {
    if (set.has(e.id)) {
      totalBytes -= e.bytes;
      return false;
    }
    return true;
  });
  const removed = q.length - remaining.length;
  if (remaining.length) queues.set(token, remaining);
  else queues.delete(token);
  return removed;
}

// Drop anything older than the TTL so we never hold receipts indefinitely.
function sweep() {
  const cutoff = Date.now() - config.pendingTtlMs;
  for (const [token, q] of queues) {
    const fresh = q.filter((e) => {
      if (e.receivedAt < cutoff) {
        totalBytes -= e.bytes;
        return false;
      }
      return true;
    });
    if (fresh.length === 0) queues.delete(token);
    else if (fresh.length !== q.length) queues.set(token, fresh);
  }
}

/** Remove the single oldest entry across all queues. Returns true if any. */
function evictOldest() {
  let oldestToken = null;
  let oldestAt = Infinity;
  for (const [token, q] of queues) {
    if (q.length > 0 && q[0].receivedAt < oldestAt) {
      oldestAt = q[0].receivedAt;
      oldestToken = token;
    }
  }
  if (oldestToken === null) return false;
  const q = queues.get(oldestToken);
  totalBytes -= q.shift().bytes;
  if (q.length === 0) queues.delete(oldestToken);
  return true;
}

export function _reset() {
  queues.clear();
  totalBytes = 0;
}
