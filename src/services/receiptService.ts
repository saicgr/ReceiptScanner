/**
 * receiptService — the bridge between the editable review draft and everything
 * that has to happen when a receipt is committed: filename generation, saving
 * the primary image to app storage, duplicate detection, content hashing,
 * protection-deadline math, local notifications, and the actual DB upsert.
 *
 * The review screen owns the draft (`useDraft`); this service is the single
 * place that turns that working copy into a persisted Receipt so the rules
 * (filename template, scan-count gating, notification scheduling) live in ONE
 * spot and can't drift between callers.
 *
 * Design notes:
 *  - Nothing is auto-finalized. `persistDraft` keeps the draft's own status
 *    unless `finalize` is requested, matching the "user finalizes" rule.
 *  - Scan count is incremented for NEW receipts only — editing an existing
 *    receipt must never burn a free scan.
 *  - Image saving and notification scheduling are best-effort: a storage or
 *    notification failure must not block the user from saving their data.
 */
import * as DB from '@/db';
import { incrementScanCount } from '@/db/settings';
import { useDraft, draftDeadlines, type DraftState } from '@/store/draft';
import { useSettings } from '@/store/settings';
import { useLookups } from '@/store/lookups';
import { buildFilename, type FilenameContext } from '@/lib/filename';
import { contentHash, duplicateScore } from '@/lib/hash';
import type { LineItem, Receipt } from '@/types';

import { persistReceiptImages } from './imagePipeline';
import {
  scheduleProtectionReminders,
  cancelReceiptReminders,
} from './notificationsService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the user's filename template + date format + image format. */
function filenamePrefs(): {
  template: string;
  dateFormat: string;
  imageFormat: 'jpg' | 'png';
} {
  const s = useSettings.getState().settings;
  return {
    template: s.filename_template,
    dateFormat: s.date_format,
    imageFormat: s.image_format,
  };
}

/** Human-readable category/payment names (used by the filename tokens). */
function lookupNames(
  categoryId: string | null,
  paymentMethodId: string | null,
): { categoryName: string | null; paymentName: string | null } {
  const lookups = useLookups.getState();
  return {
    categoryName: lookups.categoryById(categoryId)?.name ?? null,
    paymentName: lookups.paymentById(paymentMethodId)?.name ?? null,
  };
}

/** Build the {date}_{company}_{amount}-style filename for a draft snapshot. */
function filenameForDraft(state: DraftState): string {
  const { template, dateFormat, imageFormat } = filenamePrefs();
  const { categoryName, paymentName } = lookupNames(
    state.category_id,
    state.payment_method_id,
  );
  const ctx: FilenameContext = {
    date: state.date,
    vendor: state.vendor,
    total: state.total(),
    currency: state.currency,
    categoryName,
    paymentName,
    tax: state.tax,
    id: state.id,
    createdAt: new Date().toISOString(),
  };
  return buildFilename(template, ctx, imageFormat, dateFormat);
}

/** Build the same filename for an already-persisted receipt (batch rename). */
function filenameForReceipt(receipt: Receipt): string {
  const { template, dateFormat } = filenamePrefs();
  const { categoryName, paymentName } = lookupNames(
    receipt.category_id,
    receipt.payment_method_id,
  );
  const ctx: FilenameContext = {
    date: receipt.date,
    vendor: receipt.vendor,
    total: receipt.total,
    currency: receipt.currency,
    categoryName,
    paymentName,
    tax: receipt.tax,
    id: receipt.id,
    createdAt: receipt.created_at,
  };
  // Respect the format the receipt was actually saved in, not the current setting.
  return buildFilename(template, ctx, receipt.image_format, dateFormat);
}

/** Map the draft's line items into the DB's partial LineItem shape. */
function draftLineItems(state: DraftState): Partial<LineItem>[] {
  return state.lineItems.map((li, index) => ({
    id: li.id,
    name: li.name,
    qty: li.qty,
    price: li.price,
    included: li.included,
    category_id: li.category_id,
    sort_order: index,
    protection_status: li.protection_status,
    return_window_days: li.return_window_days,
    warranty_period_days: li.warranty_period_days,
    serial_number: li.serial_number,
    product_photo_uri: li.product_photo_uri,
  }));
}

/** Snapshot of the identifying fields used for hashing / duplicate scoring. */
function draftIdentity(state: DraftState): {
  vendor: string;
  date: string | null;
  total: number;
  currency: string;
} {
  return {
    vendor: state.vendor,
    date: state.date,
    total: state.total(),
    currency: state.currency,
  };
}

// ---------------------------------------------------------------------------
// persistDraft — the core commit path
// ---------------------------------------------------------------------------

/**
 * Commit the current `useDraft` working copy to the database and return the
 * receipt id.
 *
 * Steps (order matters):
 *  1. Read the draft + settings; bail with a clear error if no active draft.
 *  2. Compute the user's filename from the template.
 *  3. Copy the original AND every page image into the app's receipts dir under
 *     that name family (best-effort — failure falls back to the source uris).
 *  4. Compute the content hash for duplicate detection.
 *  5. Compute protection deadlines from the draft (return/warranty).
 *  6. Upsert: CREATE when the draft id isn't already a persisted receipt,
 *     otherwise UPDATE + replace line items / tags / images.
 *  7. Schedule (or reschedule) local protection reminders.
 *  8. Increment the scan count for NEW receipts only.
 */
export async function persistDraft(opts?: {
  finalize?: boolean;
}): Promise<string> {
  const state = useDraft.getState();
  if (!state.active || !state.id) {
    throw new Error('persistDraft: no active draft to save');
  }

  const finalize = opts?.finalize ?? false;
  const id = state.id;

  // 1) Determine whether this draft already exists in the DB (edit vs. create).
  const existing = await DB.getReceipt(id);
  const isNew = existing === null;

  // 2) Filename from the user's template. May be adjusted below: on a name
  //    collision the image is saved with a numeric suffix and we store the
  //    name the file ACTUALLY got.
  let savedFilename = filenameForDraft(state);

  // 3) Persist EVERY image durably. Camera/picker/manipulator outputs live in
  //    the OS-purgeable cache, so the ORIGINAL and ALL page images are copied
  //    into the receipts dir (page 1 under the template name, the rest as
  //    <base>_p<n> / <base>_orig) and the stored uris re-pointed at the stable
  //    copies. Best-effort: if a copy fails (e.g. web, missing file) we keep
  //    whatever uri we had so the user never loses their data over a hiccup.
  let originalImageUri: string | null = state.original_image_uri;
  let pageImageUris = [...state.imageUris];
  // No page image at all (shouldn't happen) — fall back to the original.
  if (pageImageUris.length === 0 && originalImageUri) {
    pageImageUris = [originalImageUri];
  }
  try {
    const persisted = await persistReceiptImages({
      pageUris: pageImageUris,
      originalUri: originalImageUri,
      filename: savedFilename,
    });
    pageImageUris = persisted.pageUris;
    originalImageUri = persisted.originalUri;
    savedFilename = persisted.filename;
  } catch {
    // Keep the source uris; the receipt still saves with the original image.
  }

  // Keep the in-memory draft consistent with the durable uris — the cache
  // sources may have been cleaned up after copying, and a screen still showing
  // the draft must not render deleted files.
  const afterPersist = useDraft.getState();
  if (afterPersist.active && afterPersist.id === id) {
    afterPersist.patch({
      imageUris: pageImageUris,
      original_image_uri: originalImageUri,
    });
  }

  // 4) Content hash for duplicate detection.
  const hash = contentHash(draftIdentity(state));

  // 5) Protection deadlines (return/warranty) + overall protection status.
  const deadlines = draftDeadlines(state);

  // 6) Status: only flip to finalized when explicitly asked; otherwise keep the
  //    draft's current status (a finalized receipt being re-saved stays final).
  const status = finalize ? 'finalized' : state.status;

  // Assemble the persisted receipt fields shared by create + update.
  const baseFields: Partial<Receipt> = {
    vendor: state.vendor,
    date: state.date,
    date_confidence: state.date_confidence,
    date_ambiguous: state.date_ambiguous,
    date_options: state.date_options,
    total: state.total(),
    tax: state.tax,
    subtotal: state.subtotal(),
    currency: state.currency,
    category_id: state.category_id,
    payment_method_id: state.payment_method_id,
    memo: state.memo,
    original_image_uri: originalImageUri,
    saved_filename: savedFilename,
    image_format: state.image_format,
    source: state.source,
    status,
    content_hash: hash,
    duplicate_of: state.duplicateOfId,
    field_confidence: state.field_confidence,
    return_window_days: state.return_window_days,
    warranty_period_days: state.warranty_period_days,
    return_deadline: deadlines.return_deadline,
    warranty_deadline: deadlines.warranty_deadline,
    protection_status: deadlines.protection_status,
    tax_category_id: state.tax_category_id,
    is_deductible: state.is_deductible,
    deductible_percent: state.deductible_percent,
    condition_tags: state.condition_tags,
    captured_at: state.captured_at,
    captured_lat: state.captured_lat,
    captured_lng: state.captured_lng,
  };

  const lineItems = draftLineItems(state);

  if (isNew) {
    // createReceipt inserts the receipt, its line items, page images and tags
    // in one transaction and recomputes totals/subtotal for us.
    await DB.createReceipt({
      id,
      ...baseFields,
      line_items: lineItems,
      image_uris: pageImageUris,
      tag_ids: state.tagIds,
    });
  } else {
    // Update path: patch the receipt then replace its child rows so deletions
    // in the review screen are honored.
    await DB.updateReceipt(id, baseFields);
    await DB.replaceLineItems(id, lineItems);
    await DB.setReceiptTags(id, state.tagIds);
    await DB.setReceiptImages(id, pageImageUris);
    // replaceLineItems recomputes totals from items; when there are no items the
    // user-entered total stands (already written via updateReceipt above).
  }

  // 7) (Re)schedule protection reminders. Cancel any prior ones on edit so we
  //    don't leave stale notifications behind, then schedule fresh ones. Wrapped
  //    so a notifications failure never blocks the save.
  try {
    if (!isNew) {
      await cancelReceiptReminders(id);
    }
    if (deadlines.return_deadline || deadlines.warranty_deadline) {
      const settings = useSettings.getState().settings;
      await scheduleProtectionReminders(
        { id, vendor: state.vendor },
        {
          returnDeadline: deadlines.return_deadline,
          warrantyDeadline: deadlines.warranty_deadline,
          itemName: state.vendor,
          returnDaysBefore: settings.notify_return_days_before,
          warrantyDaysBefore: settings.notify_warranty_days_before,
        },
      );
    }
  } catch {
    // Reminders are a nice-to-have; the receipt is already saved.
  }

  // 8) Count this against the free-scan quota only for brand-new receipts.
  //    The in-memory settings store is synced immediately so canScan() /
  //    scansRemaining() gate correctly DURING a batch, not just after a reload.
  if (isNew) {
    try {
      const next = await incrementScanCount();
      const store = useSettings.getState();
      useSettings.setState({
        settings: { ...store.settings, scan_count: next },
      });
    } catch {
      // Non-fatal: gating is advisory, the data is already persisted.
    }
  }

  return id;
}

// ---------------------------------------------------------------------------
// checkDuplicate — warn before the user re-saves the same receipt
// ---------------------------------------------------------------------------

/**
 * Look for a near-identical existing receipt for the CURRENT draft. Returns the
 * best candidate scoring >= 0.75 (the Scan/Review warning threshold) or null.
 * Excludes the draft's own id so editing an existing receipt never flags itself.
 */
export async function checkDuplicate(): Promise<{
  id: string;
  score: number;
} | null> {
  const state = useDraft.getState();
  if (!state.active) return null;

  const identity = draftIdentity(state);
  const hash = contentHash(identity);

  const candidates = await DB.findPotentialDuplicates(
    hash,
    identity.vendor,
    identity.total,
    identity.date,
    state.id || undefined,
  );

  let best: { id: string; score: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.id === state.id) continue; // never match self
    const score = duplicateScore(identity, {
      vendor: candidate.vendor,
      date: candidate.date,
      total: candidate.total,
      currency: candidate.currency,
    });
    if (score >= 0.75 && (best === null || score > best.score)) {
      best = { id: candidate.id, score };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// batchRename — apply the current filename template to existing receipts
// ---------------------------------------------------------------------------

/**
 * Regenerate `saved_filename` for each given receipt from the CURRENT template
 * and date format, renaming the stored image files (all pages + original) to
 * match. Returns the number of receipts whose filename actually changed.
 *
 * This delivers the explicit "batch re-naming of existing receipts" demand.
 */
export async function batchRename(receiptIds: string[]): Promise<number> {
  let updated = 0;

  for (const id of receiptIds) {
    const receipt = await DB.getReceipt(id);
    if (!receipt) continue;

    let nextFilename = filenameForReceipt(receipt);
    // Up to date — including when the saved name only differs by the numeric
    // collision suffix saveImageWithName appends (renaming "name_2.jpg" to
    // "name.jpg" would just collide and cycle suffixes forever).
    const stripSuffix = (n: string) => n.replace(/_\d+(\.[A-Za-z0-9]+)$/, '$1');
    if (
      receipt.saved_filename != null &&
      (nextFilename === receipt.saved_filename ||
        nextFilename === stripSuffix(receipt.saved_filename))
    ) {
      continue;
    }

    // Re-save the WHOLE image family (every page + the retained original)
    // under the new name; persistReceiptImages deletes the superseded files in
    // the receipts dir so repeated renames don't leak disk, and handles name
    // collisions with a numeric suffix (the actual name is what we store).
    // Best-effort: a copy failure keeps the old uris but still updates the
    // stored filename string (the user can re-export later).
    const pageUris = receipt.images.map((img) => img.uri);
    let nextPages = pageUris;
    let nextOriginal = receipt.original_image_uri;
    try {
      const persisted = await persistReceiptImages({
        pageUris,
        originalUri: receipt.original_image_uri,
        filename: nextFilename,
      });
      nextPages = persisted.pageUris;
      nextOriginal = persisted.originalUri;
      nextFilename = persisted.filename;
    } catch {
      // Keep the existing uris; the filename string below still updates.
    }

    await DB.updateReceipt(id, {
      saved_filename: nextFilename,
      original_image_uri: nextOriginal,
    });
    if (nextPages.length > 0) {
      await DB.setReceiptImages(id, nextPages);
    }

    updated += 1;
  }

  return updated;
}

// ---------------------------------------------------------------------------
// deleteReceiptCascade — remove a receipt and its scheduled reminders
// ---------------------------------------------------------------------------

/**
 * Delete a receipt, first cancelling any local notifications scheduled for it so
 * the user never gets a "return window closing" alert for a receipt they've
 * already removed. Child rows (line items, tags, images) cascade in the DB.
 */
export async function deleteReceiptCascade(id: string): Promise<void> {
  try {
    await cancelReceiptReminders(id);
  } catch {
    // Cancelling reminders is best-effort; proceed with the delete regardless.
  }
  await DB.deleteReceipt(id);
}
