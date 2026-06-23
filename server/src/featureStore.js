// Durable storage for the Roadmap & Feature-Request feature, backed by Supabase.
//
// This is the ONLY persistent storage in the proxy. It holds two things, neither
// of which is a user receipt (the "no server-side receipt storage" promise is
// intact): roadmap upvotes and private feature-request submissions. Devices are
// stored only as a sha256 hash, never the raw id.
//
// Everything degrades gracefully: when Supabase isn't configured (no env vars)
// or a query throws, READS return empty (so GET /roadmap still renders curated
// items at zero votes) and WRITES throw a tagged `store_unavailable` error that
// the routes turn into a 503. The proxy never crashes on a storage outage.
//
// The server uses the SERVICE ROLE key, which bypasses RLS — so the tables can
// (and should) have RLS enabled with no anon policies, locking out the public.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { config } from './config.js';

/** Lazily-constructed singleton client (null when unconfigured). */
let client;
let triedInit = false;

function getClient() {
  if (triedInit) return client;
  triedInit = true;
  const { url, serviceRoleKey } = config.supabase;
  if (!url || !serviceRoleKey) {
    client = null;
    return null;
  }
  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Whether durable storage is available (env configured). */
export function isConfigured() {
  return Boolean(getClient());
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
  const db = getClient();
  if (!db) return {};
  try {
    // No SQL aggregate over the JS client without an RPC; pull the (small) id
    // column and count in memory. Roadmap vote volume is tiny by nature.
    const { data, error } = await db.from('roadmap_votes').select('item_id');
    if (error) throw error;
    const counts = {};
    for (const row of data ?? []) {
      counts[row.item_id] = (counts[row.item_id] ?? 0) + 1;
    }
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
  const db = getClient();
  if (!db) return new Set();
  try {
    const { data, error } = await db
      .from('roadmap_votes')
      .select('item_id')
      .eq('device_hash', deviceHash);
    if (error) throw error;
    return new Set((data ?? []).map((r) => r.item_id));
  } catch (err) {
    console.error('[featureStore] getDeviceVotes failed:', err.message);
    return new Set();
  }
}

/**
 * Toggle this device's vote on an item. Inserts when absent, deletes when
 * present. Returns { voted, count } with the fresh count for that item.
 * Throws `store_unavailable` (503) when storage isn't configured.
 */
export async function toggleVote(itemId, deviceHash) {
  const db = getClient();
  if (!db) throw storeUnavailable();

  // Is there an existing vote for this (item, device)?
  const { data: existing, error: selErr } = await db
    .from('roadmap_votes')
    .select('item_id')
    .eq('item_id', itemId)
    .eq('device_hash', deviceHash)
    .maybeSingle();
  if (selErr) throw selErr;

  let voted;
  if (existing) {
    const { error } = await db
      .from('roadmap_votes')
      .delete()
      .eq('item_id', itemId)
      .eq('device_hash', deviceHash);
    if (error) throw error;
    voted = false;
  } else {
    // Upsert keyed on the composite PK so a double-tap race can't 409.
    const { error } = await db
      .from('roadmap_votes')
      .upsert({ item_id: itemId, device_hash: deviceHash }, { onConflict: 'item_id,device_hash' });
    if (error) throw error;
    voted = true;
  }

  const { count, error: cntErr } = await db
    .from('roadmap_votes')
    .select('*', { count: 'exact', head: true })
    .eq('item_id', itemId);
  if (cntErr) throw cntErr;

  return { voted, count: count ?? 0 };
}

// ---------------------------------------------------------------------------
// Feature requests (private submissions)
// ---------------------------------------------------------------------------

/**
 * Persist a feature request. Returns { id }. Throws `store_unavailable` (503)
 * when storage isn't configured.
 */
export async function insertFeatureRequest({ deviceHash, title, description, category }) {
  const db = getClient();
  if (!db) throw storeUnavailable();
  const { data, error } = await db
    .from('feature_requests')
    .insert({
      device_hash: deviceHash,
      title,
      description: description ?? '',
      category: category ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id };
}
