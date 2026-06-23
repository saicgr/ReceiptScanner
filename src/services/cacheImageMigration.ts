/**
 * One-time migration: move receipt images off the OS-purgeable cache directory
 * into permanent app storage (TASK 35).
 *
 * Camera output, ImageManipulator results and picker copies all land in
 * `FileSystem.cacheDirectory`, which the OS may purge at any time under storage
 * pressure. Earlier builds stored those cache uris directly on the receipt, so a
 * purge could silently delete a receipt's "always kept" original image. The
 * persist step (`persistReceiptImages`) now copies everything into
 * `RECEIPTS_DIR`, but receipts saved BEFORE that fix may still point at the
 * cache. This migration finds them and re-persists their image family.
 *
 * It is guarded by the `cache_image_migration_done` settings flag so it runs at
 * most once. It is fully best-effort: any per-receipt failure is logged and
 * skipped (the flag is still set so we don't loop forever), and a receipt whose
 * cache file has already been purged simply keeps its existing uri.
 */
import * as FileSystem from 'expo-file-system/legacy';

import * as DB from '@/db';
import { useSettings } from '@/store/settings';
import { persistReceiptImages, RECEIPTS_DIR } from './imagePipeline';

/** Does this uri live in the OS-purgeable cache directory (and not already in our dir)? */
function isCacheUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  const cache = FileSystem.cacheDirectory;
  if (!cache) return false;
  return uri.startsWith(cache) && !uri.startsWith(RECEIPTS_DIR);
}

/**
 * Re-persist any receipt whose original or page images point at the cache dir.
 * Returns the number of receipts that were migrated. Never throws.
 */
export async function migrateCacheImages(): Promise<number> {
  let migrated = 0;
  try {
    // listReceipts returns lightweight rows; we load relations per-candidate.
    const all = await DB.listReceipts({ status: 'all' });
    for (const r of all) {
      try {
        const full = await DB.getReceipt(r.id);
        if (!full) continue;

        const pageUris = full.images.map((img) => img.uri);
        const needsMigration =
          isCacheUri(full.original_image_uri) || pageUris.some(isCacheUri);
        if (!needsMigration) continue;

        // Reuse the canonical persist logic: copies the whole family into
        // RECEIPTS_DIR under the receipt's saved filename and returns the
        // durable uris (collision suffixes handled inside).
        const persisted = await persistReceiptImages({
          pageUris,
          originalUri: full.original_image_uri,
          filename: full.saved_filename ?? `${r.id}.${full.image_format ?? 'jpg'}`,
        });

        await DB.updateReceipt(r.id, {
          original_image_uri: persisted.originalUri,
          saved_filename: persisted.filename,
        });
        if (persisted.pageUris.length > 0) {
          await DB.setReceiptImages(r.id, persisted.pageUris);
        }
        migrated += 1;
      } catch (e) {
        // Per-receipt failure (purged file, FS error) — skip and continue.
        if (__DEV__) console.warn(`[cacheImageMigration] skipped ${r.id}:`, e);
      }
    }
  } catch (e) {
    if (__DEV__) console.warn('[cacheImageMigration] failed to enumerate receipts:', e);
  }
  return migrated;
}

/**
 * Run the migration ONCE, guarded by the `cache_image_migration_done` settings
 * flag. Safe to call on every launch — it returns immediately once the flag is
 * set. The flag is set even on partial failure so a permanently-broken receipt
 * can't trap the app in a re-migration loop.
 */
export async function runCacheImageMigrationOnce(): Promise<void> {
  const { settings, update } = useSettings.getState();
  if (settings.cache_image_migration_done) return;
  try {
    const n = await migrateCacheImages();
    if (__DEV__ && n > 0) {
      console.log(`[cacheImageMigration] migrated ${n} receipt(s) off the cache dir`);
    }
  } finally {
    // Mark done regardless so this never re-runs on subsequent launches.
    try {
      await update({ cache_image_migration_done: true });
    } catch {
      // If we can't persist the flag we'll retry next launch — acceptable.
    }
  }
}
