// Durable storage for the Roadmap & Feature-Request feature, backed by Neon
// (serverless Postgres, queried over HTTP — no connection pool to manage).
//
// This is the ONLY persistent storage in the proxy. It holds two things, neither
// of which is a user receipt (the "no server-side receipt storage" promise is
// intact): roadmap upvotes and private feature-request submissions. Devices are
// stored only as a sha256 hash, never the raw id.
//
// Everything degrades gracefully: when Neon isn't configured (no DATABASE_URL)
// or a query throws, READS return empty (so GET /roadmap still renders curated
// items at zero votes) and WRITES throw a tagged `store_unavailable` error that
// the routes turn into a 503. The proxy never crashes on a storage outage.
//
// The connection string is the only credential and it is server-side only —
// there is no public/anon API surface in front of this database, so no RLS
// policies are needed to keep it private.
import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';
import { config } from './config.js';

/** Lazily-constructed singleton query function (null when unconfigured). */
let sql;
let triedInit = false;

function getSql() {
  if (triedInit) return sql;
  triedInit = true;
  const { databaseUrl } = config.neon;
  sql = databaseUrl ? neon(databaseUrl) : null;
  return sql;
}

/** Whether durable storage is available (env configured). */
export function isConfigured() {
  return Boolean(getSql());
}

/** Hash a device id so we never persist the raw value. */
export function hashDevice(deviceId) {
  return createHash('sha256').update(String(deviceId)).digest('hex');
}

/** Error the routes recognize and map to a 503. */
function storeUnavailable(message) {
  const err = new Error(message || 'Feature storage is not configured on this server.');
  err.code = 'store_unavailable';
  err.status = 503;
  return err;
}

// ---------------------------------------------------------------------------
// Roadmap votes
// ---------------------------------------------------------------------------

/**
 * Aggregate upvote counts per roadmap item id: { [itemId]: count }.
 * Returns {} when storage is unavailable or on any error (graceful degrade).
 */
export async function getVoteCounts() {
  const db = getSql();
  if (!db) return {};
  try {
    const rows = await db`
      select item_id, count(*)::int as count
        from roadmap_votes
       group by item_id
    `;
    const counts = {};
    for (const row of rows) counts[row.item_id] = row.count;
    return counts;
  } catch (err) {
    console.error('[featureStore] getVoteCounts failed:', err.message);
    return {};
  }
}

/**
 * The set of item ids this device has voted for. Returns an empty Set when
 * storage is unavailable or on error.
 */
export async function getDeviceVotes(deviceHash) {
  const db = getSql();
  if (!db) return new Set();
  try {
    const rows = await db`
      select item_id from roadmap_votes where device_hash = ${deviceHash}
    `;
    return new Set(rows.map((r) => r.item_id));
  } catch (err) {
    console.error('[featureStore] getDeviceVotes failed:', err.message);
    return new Set();
  }
}

/**
 * Toggle this device's vote on an item. Inserts when absent, deletes when
 * present. Returns { voted, count } with the fresh state for that item.
 * Throws `store_unavailable` (503) when storage isn't configured.
 */
export async function toggleVote(itemId, deviceHash) {
  const db = getSql();
  if (!db) throw storeUnavailable();

  // Delete-or-insert in ONE statement: `inserted` reads the RETURNING output of
  // `deleted`, so the insert only fires when nothing was deleted. `on conflict`
  // keeps a double-tap race from erroring.
  await db`
    with deleted as (
      delete from roadmap_votes
       where item_id = ${itemId} and device_hash = ${deviceHash}
      returning 1
    )
    insert into roadmap_votes (item_id, device_hash)
    select ${itemId}, ${deviceHash}
     where not exists (select 1 from deleted)
    on conflict (item_id, device_hash) do nothing
  `;

  // Re-read rather than inferring from the toggle: this reports the row's ACTUAL
  // state, so a concurrent double-tap can't leave the client showing the wrong
  // vote state. Both values come back in a single round trip.
  const [row] = await db`
    select count(*)::int as count,
           coalesce(bool_or(device_hash = ${deviceHash}), false) as voted
      from roadmap_votes
     where item_id = ${itemId}
  `;

  return { voted: row.voted, count: row.count };
}

// ---------------------------------------------------------------------------
// Feature requests (private submissions)
// ---------------------------------------------------------------------------

/**
 * Persist a feature request. Returns { id }. Throws `store_unavailable` (503)
 * when storage isn't configured.
 */
export async function insertFeatureRequest({ deviceHash, title, description, category }) {
  const db = getSql();
  if (!db) throw storeUnavailable();
  const [row] = await db`
    insert into feature_requests (device_hash, title, description, category)
    values (${deviceHash}, ${title}, ${description ?? ''}, ${category ?? null})
    returning id
  `;
  return { id: row.id };
}
