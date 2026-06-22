/**
 * Email-receipt forwarding client (Expensify-style ingestion).
 *
 * The backend mints a unique forwarding address per device
 * (`user-<token>@inbox.receiptsnap.app`). E-receipts forwarded there are parsed
 * through the same Gemini pipeline and parked in a per-token pending queue. This
 * service talks to those three stateless endpoints (all authenticated with the
 * X-Device-Id + X-Device-Token pair via `authedFetch`; the server derives the
 * short email-routing token from the authenticated device id):
 *
 *   GET  /forwarding-address          -> { token, address }
 *   GET  /pending                     -> { token, items: [...] }
 *   POST /pending/ack  { ids }        -> { ok, removed }
 *
 * `importPendingReceipts()` is the consumer: it persists EVERY pending item
 * locally (attachment image written to a permanent file, receipt saved as a
 * pending draft) and only then acks it, so nothing is ever lost or re-imported.
 *
 * No receipts are stored on our servers beyond the short-lived pending queue;
 * once the app polls + acks, they live only in the local SQLite DB.
 */
import * as FileSystem from 'expo-file-system/legacy';

import { appConfig } from '@/lib/config';
import { getDeviceId, forwardingTokenFromDeviceId } from '@/lib/device';
import { getSetting, updateSettings } from '@/db/settings';
import { useDraft } from '@/store/draft';
import type { ExtractionResult, ImageFormat } from '@/types';

import { authedFetch } from './extractClient';
import { persistDraft } from './receiptService';

/** Network timeout for the (small, fast) forwarding endpoints. */
const REQUEST_TIMEOUT_MS = 12_000;

/** A single email-ingested receipt awaiting review in the local pending list. */
export interface PendingReceipt {
  id: string;
  extraction: ExtractionResult;
  imageBase64: string | null;
  imageMimeType: string | null;
}

/** Shape of one item as returned by GET /pending (extra fields tolerated). */
interface PendingItemResponse {
  id?: string;
  extraction?: ExtractionResult;
  imageBase64?: string | null;
  imageMimeType?: string | null;
  source?: string;
  receivedAt?: string;
}

/** Join base URL + path, tolerating a trailing slash on the configured base. */
function apiUrl(path: string): string {
  const base = appConfig.apiBaseUrl.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Authenticated fetch() with an abort-based timeout so a hung backend never
 * blocks the UI. Delegates header handling (and 401 re-registration) to
 * `authedFetch` from the extract client.
 */
async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await authedFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve this device's forwarding address from the backend and persist it to
 * settings so the rest of the app (Home card, Settings) can read it offline.
 *
 * On any network/server failure we fall back to the locally-derived token
 * (which matches the backend's `sha256(deviceId).slice(0,10)`) so the user
 * always sees a usable address. The fallback is also persisted.
 */
export async function fetchForwardingAddress(): Promise<{
  token: string;
  address: string;
}> {
  const deviceId = await getDeviceId();
  try {
    const res = await fetchWithTimeout(apiUrl('/forwarding-address'), {
      method: 'GET',
    });
    if (!res.ok) {
      throw new Error(`forwarding-address HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      token?: string;
      address?: string;
    };
    if (!data.token || !data.address) {
      throw new Error('forwarding-address response missing token/address');
    }
    await updateSettings({
      forwarding_token: data.token,
      forwarding_address: data.address,
    });
    return { token: data.token, address: data.address };
  } catch (err) {
    // Offline fallback: derive the same token the backend would and build the
    // address locally. Reuse a previously-persisted value when present.
    const existingToken = await getSetting('forwarding_token');
    const token = existingToken || (await forwardingTokenFromDeviceId(deviceId));
    const existingAddress = await getSetting('forwarding_address');
    const address =
      existingAddress || `user-${token}@inbox.receiptsnap.app`;
    await updateSettings({
      forwarding_token: token,
      forwarding_address: address,
    });
    if (__DEV__) {
      console.warn(
        '[emailIngest] forwarding-address fetch failed, using local fallback:',
        err,
      );
    }
    return { token, address };
  }
}

/**
 * Poll the backend pending queue for email-forwarded receipts. Returns a
 * normalized list ready to drop into the review flow. Returns an empty array
 * (never throws) when offline or when the queue is empty. The server resolves
 * the queue from the authenticated device id — no token round-trip needed.
 */
export async function pollPending(): Promise<PendingReceipt[]> {
  try {
    const res = await fetchWithTimeout(apiUrl('/pending'), { method: 'GET' });
    if (!res.ok) {
      throw new Error(`pending HTTP ${res.status}`);
    }
    const data = (await res.json()) as { items?: PendingItemResponse[] };
    const items = Array.isArray(data.items) ? data.items : [];
    // Keep only well-formed entries (id + extraction present).
    return items
      .filter((it): it is PendingItemResponse & {
        id: string;
        extraction: ExtractionResult;
      } => typeof it.id === 'string' && it.extraction != null)
      .map((it) => ({
        id: it.id,
        extraction: it.extraction,
        imageBase64: it.imageBase64 ?? null,
        imageMimeType: it.imageMimeType ?? null,
      }));
  } catch (err) {
    if (__DEV__) {
      console.warn('[emailIngest] pollPending failed:', err);
    }
    return [];
  }
}

/**
 * Acknowledge pending items by id so the backend clears them from the queue
 * (call AFTER the receipts have been imported locally). Best-effort: a failed
 * ack just means the items reappear on the next poll, so we never throw.
 */
export async function ackPending(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const res = await fetchWithTimeout(apiUrl('/pending/ack'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok && __DEV__) {
      console.warn('[emailIngest] ackPending HTTP', res.status);
    }
  } catch (err) {
    if (__DEV__) {
      console.warn('[emailIngest] ackPending failed:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Importing pending items into the local DB
// ---------------------------------------------------------------------------

/**
 * Where email-ingested originals are persisted. Mirrors the imagePipeline
 * `receipts/` pattern under the app's document storage (implemented locally so
 * this service doesn't drag the whole capture pipeline in); files here are
 * permanent until the receipt is deleted.
 */
const EMAIL_RECEIPTS_DIR = `${FileSystem.documentDirectory}receipts/email/`;

/** Ensure the email-receipts directory exists (idempotent, best-effort). */
async function ensureEmailReceiptsDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(EMAIL_RECEIPTS_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(EMAIL_RECEIPTS_DIR, {
        intermediates: true,
      });
    }
  } catch {
    // The subsequent write surfaces a real error if the dir truly can't exist.
  }
}

/** File extension matching the attachment's mime type; defaults to jpg. */
function extensionForMime(mime: string | null): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  return 'jpg';
}

/**
 * Write a pending item's base64 attachment to a permanent file so the original
 * e-receipt image survives the import (full-original-image is a core promise).
 * Returns the file uri, or null when the item has no image / the write fails.
 */
async function savePendingImage(item: PendingReceipt): Promise<string | null> {
  if (!item.imageBase64) return null;
  try {
    await ensureEmailReceiptsDir();
    const uri = `${EMAIL_RECEIPTS_DIR}email_${item.id}.${extensionForMime(item.imageMimeType)}`;
    await FileSystem.writeAsStringAsync(uri, item.imageBase64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return uri;
  } catch (err) {
    if (__DEV__) {
      console.warn('[emailIngest] failed to persist pending image:', err);
    }
    return null;
  }
}

/**
 * Pull ALL pending email receipts and import each one as a local PENDING
 * receipt (nothing is auto-finalized — the user reviews them like any scan):
 *
 *   1. write the attachment image (if any) to a permanent file,
 *   2. build a draft from the extraction and persist it via the same
 *      `persistDraft` path every scan uses (filename template, dup hash, …),
 *   3. ack the item ONLY after it is durably saved, so a crash mid-import
 *      means a re-poll, never a lost receipt.
 *
 * Returns the ids of the imported receipts (empty when offline / queue empty).
 */
export async function importPendingReceipts(): Promise<string[]> {
  const pending = await pollPending();
  if (pending.length === 0) return [];

  let imageFormat: ImageFormat = 'jpg';
  try {
    imageFormat = await getSetting('image_format');
  } catch {
    // Settings DB not ready — jpg default is fine.
  }

  const imported: string[] = [];
  for (const item of pending) {
    try {
      const imageUri = await savePendingImage(item);
      useDraft.getState().startFromExtraction(item.extraction, {
        imageUris: imageUri ? [imageUri] : [],
        originalImageUri: imageUri,
        source: 'email',
        imageFormat,
      });
      const receiptId = await persistDraft();
      imported.push(receiptId);
      // Durably saved locally — now (and only now) clear it server-side.
      await ackPending([item.id]);
    } catch (err) {
      if (__DEV__) {
        console.warn('[emailIngest] failed to import pending item', item.id, err);
      }
      // Left un-acked on purpose: it will reappear on the next poll.
    }
  }
  // Don't leave the last import lingering as the active review draft.
  useDraft.getState().reset();
  return imported;
}
