/**
 * qrShareService — orchestration for the QR sharing + scanning features
 * (TASKS 68/69/70). All on-device; the ONLY network call is the optional
 * e-receipt URL fetch in TASK 68, which degrades gracefully.
 *
 *  - TASK 70: prepareReceiptDataShare → a data-only QR string, OR a file
 *    fallback when the payload is too big for a QR.
 *  - TASK 69: prepareReceiptLinkShare → a QR encoding a cloud share LINK; gated
 *    on the receipt being backed up first (we host nothing).
 *  - TASK 68: importScannedReceiptData → import a scanned data payload as a new
 *    pending receipt; fetchAndExtractFromUrl → fetch an e-receipt URL and run it
 *    through the existing extract pipeline.
 *
 * The pure encode/decode logic lives in src/lib/receiptQr.ts; this module only
 * wires it to the DB, settings, file-system and network.
 */
import * as FileSystem from 'expo-file-system/legacy';

import * as DB from '@/db';
import { newId } from '@/lib/id';
import { useSettings } from '@/store/settings';
import { sumIncluded } from '@/lib/money';
import {
  encodeLinkEnvelope,
  encodeReceiptForQr,
  payloadToExtraction,
  type ReceiptQrPayload,
} from '@/lib/receiptQr';
import { extractReceipt } from './extractClient';
import { shareFile } from './exporters';
import type { ExtractionResult, FieldConfidence, ReceiptWithRelations } from '@/types';

// ---------------------------------------------------------------------------
// TASK 70 — data-only QR share
// ---------------------------------------------------------------------------

/** Result of preparing a data-only share: either a QR string or a file fallback. */
export type DataShareResult =
  | { mode: 'qr'; text: string; byteLength: number }
  | { mode: 'file'; fileUri: string; byteLength: number; cap: number };

/**
 * Prepare a receipt's data-only share. Returns the string to render as a QR when
 * it fits; otherwise writes the same JSON to a `.receiptsnap.json` file and
 * returns it so the caller can tell the user to share the file instead of
 * drawing a broken QR. The image NEVER travels in either path.
 */
export async function prepareReceiptDataShare(
  receipt: ReceiptWithRelations,
): Promise<DataShareResult> {
  const result = encodeReceiptForQr(receipt);
  if (result.ok) {
    return { mode: 'qr', text: result.text, byteLength: result.byteLength };
  }
  // Too large for a QR — fall back to a data file the user can share.
  const fileUri = await writeShareFile(result.text, receipt.vendor);
  return { mode: 'file', fileUri, byteLength: result.byteLength, cap: result.cap };
}

const SHARE_DIR = `${FileSystem.cacheDirectory}qr-share/`;

function safeStem(name: string): string {
  const slug = (name || 'receipt')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'receipt';
}

/** Write the data payload to a shareable file (the oversize fallback). */
async function writeShareFile(text: string, vendor: string): Promise<string> {
  const info = await FileSystem.getInfoAsync(SHARE_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(SHARE_DIR, { intermediates: true });
  const uri = `${SHARE_DIR}${safeStem(vendor)}-${Date.now()}.receiptsnap.json`;
  await FileSystem.writeAsStringAsync(uri, text, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return uri;
}

/** Hand a prepared share file to the OS share sheet (oversize fallback). */
export async function shareDataFile(fileUri: string): Promise<void> {
  await shareFile(fileUri);
}

// ---------------------------------------------------------------------------
// TASK 69 — cloud-link QR share (requires a backup; we host nothing)
// ---------------------------------------------------------------------------

/** Result of preparing a link share. */
export type LinkShareResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'not_backed_up' | 'no_link'; message: string };

/**
 * Prepare a QR that encodes a cloud share LINK to the full receipt (incl.
 * image). Because we store nothing server-side, this requires the user to have
 * backed up first; when they haven't, we return `not_backed_up` so the UI can
 * prompt them to back up. `cloudLink` is the user-supplied/derived share URL to
 * their own Drive/OneDrive copy.
 */
export function prepareReceiptLinkShare(
  receipt: ReceiptWithRelations,
  cloudLink: string | null,
): LinkShareResult {
  const lastBackup = useSettings.getState().settings.last_backup_at;
  if (!lastBackup) {
    return {
      ok: false,
      reason: 'not_backed_up',
      message:
        'Back up this receipt to your own cloud first — the QR links to your cloud copy (we host nothing).',
    };
  }
  const link = (cloudLink ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(link)) {
    return {
      ok: false,
      reason: 'no_link',
      message: 'Paste the share link from your cloud backup to encode it as a QR.',
    };
  }
  return { ok: true, text: encodeLinkEnvelope(link, receipt.vendor || undefined) };
}

// ---------------------------------------------------------------------------
// TASK 68 — import a scanned data payload as a new pending receipt
// ---------------------------------------------------------------------------

/**
 * Import a scanned data-only payload as a NEW receipt. Reuses the same
 * ExtractionResult contract the normal scan flow produces and creates the
 * receipt with status 'pending' so the importer reviews it like any other scan.
 * Returns the new receipt id. Does NOT count against the free-scan quota
 * (no extraction call was made) and never carries an image.
 */
export async function importScannedReceiptData(payload: ReceiptQrPayload): Promise<string> {
  const extraction: ExtractionResult = payloadToExtraction(payload);
  const id = newId();
  const items = extraction.line_items.map((li, index) => ({
    id: newId(),
    name: li.name,
    qty: li.qty,
    price: li.price,
    included: true,
    category_id: null,
    sort_order: index,
    protection_status: 'none' as const,
    return_window_days: null,
    warranty_period_days: null,
    serial_number: null,
    product_photo_uri: null,
  }));
  const subtotal = sumIncluded(items);
  const hasItems = items.length > 0;
  // payloadToExtraction always returns a fully-populated field_confidence; widen
  // the optional/Partial type to the concrete one createReceipt expects.
  const fieldConfidence: FieldConfidence = {
    vendor: extraction.field_confidence?.vendor ?? 'medium',
    date: extraction.field_confidence?.date ?? 'medium',
    total: extraction.field_confidence?.total ?? 'medium',
    tax: extraction.field_confidence?.tax ?? 'medium',
  };

  await DB.createReceipt({
    id,
    vendor: extraction.vendor,
    date: extraction.date,
    date_confidence: extraction.date_confidence,
    date_ambiguous: extraction.date_ambiguous,
    date_options: extraction.date_options,
    total: hasItems ? undefined : extraction.total,
    tax: extraction.tax,
    subtotal,
    currency: extraction.currency,
    category_id: null,
    payment_method_id: null,
    memo: '',
    original_image_uri: null,
    saved_filename: null,
    image_format: useSettings.getState().settings.image_format,
    source: 'manual',
    status: 'pending',
    content_hash: null,
    duplicate_of: null,
    field_confidence: fieldConfidence,
    return_window_days: null,
    warranty_period_days: null,
    return_deadline: null,
    warranty_deadline: null,
    protection_status: 'none',
    tax_category_id: null,
    is_deductible: false,
    deductible_percent: 100,
    condition_tags: extraction.condition ?? [],
    captured_at: null,
    captured_lat: null,
    captured_lng: null,
    line_items: items,
    image_uris: [],
    tag_ids: [],
  });

  return id;
}

// ---------------------------------------------------------------------------
// TASK 68 — fetch an e-receipt URL and route it through the extract pipeline
// ---------------------------------------------------------------------------

/** Abort the e-receipt fetch after this long; we'd rather fail than hang. */
const URL_FETCH_TIMEOUT_MS = 15000;

/**
 * Fetch the content of a scanned e-receipt URL and run it through the existing
 * extract pipeline (the backend Gemini proxy, with its offline fallback). HTML
 * is reduced to text before extraction. Returns null on ANY failure (offline,
 * timeout, non-OK, blocked) so the scanner can degrade gracefully and offer a
 * normal photo scan instead — never throws.
 */
export async function fetchAndExtractFromUrl(url: string): Promise<ExtractionResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const text = /html/i.test(contentType) ? htmlToText(body) : body;
    if (!text.trim()) return null;
    // Reuse the OCR-text path of the extractor (no image — it's a digital receipt).
    return await extractReceipt({ ocrText: text.slice(0, 20000) });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip tags/scripts from HTML into readable text for the extractor. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
