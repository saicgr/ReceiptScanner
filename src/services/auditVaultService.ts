/**
 * auditVaultService (TASK 84) — "audit defense" export.
 *
 * Packages everything you'd hand an auditor for a date range: a fully ITEMIZED
 * export (the existing exporter, which already carries every line item, memo and
 * tags) PLUS every RETAINED ORIGINAL receipt image in that range. Each artifact
 * is handed to the OS share sheet in turn so the user can route the whole bundle
 * to Drive / OneDrive / email.
 *
 * Generated entirely on-device. The original images are the user's proof of
 * purchase; the itemized export is the human/spreadsheet-readable ledger.
 */
import * as DB from '@/db';
import type { ExportFilter } from '@/types';
import { exportReceipts, shareFile } from './exporters';

export interface AuditPacketResult {
  /** Files written + shared (the itemized export(s)). */
  exportUris: string[];
  /** Original image uris shared as proof of purchase. */
  imageUris: string[];
  receiptCount: number;
}

/**
 * Build + share an audit-defense packet for `filter` (typically a date range).
 *
 * @param formats which itemized exports to include (default: a spreadsheet CSV
 *        and a printable PDF). HTML/accounting formats are also accepted.
 * @param includeImages share the retained original images too (default true).
 *
 * Throws 'empty-range' when no receipts match so the caller can message the user.
 */
export async function exportAuditPacket(
  filter: ExportFilter,
  opts?: { formats?: ('csv' | 'pdf' | 'html')[]; includeImages?: boolean },
): Promise<AuditPacketResult> {
  const formats = opts?.formats ?? ['csv', 'pdf'];
  const includeImages = opts?.includeImages ?? true;

  // Pull the matching receipts with relations so we can collect their images.
  const receipts = await DB.listReceiptsWithRelations(filter);
  if (receipts.length === 0) {
    throw new Error('empty-range');
  }

  // 1) Itemized export artifact(s).
  const exportUris: string[] = [];
  for (const format of formats) {
    const uri = await exportReceipts(format, filter);
    exportUris.push(uri);
  }

  // 2) Retained original images (de-duplicated). Prefer the stored page images;
  //    fall back to the original_image_uri when a receipt has no page rows.
  const imageUris: string[] = [];
  if (includeImages) {
    const seen = new Set<string>();
    for (const r of receipts) {
      const uris = r.images.length > 0
        ? r.images.map((img) => img.uri)
        : r.original_image_uri
          ? [r.original_image_uri]
          : [];
      for (const uri of uris) {
        if (uri && !seen.has(uri)) {
          seen.add(uri);
          imageUris.push(uri);
        }
      }
    }
  }

  // 3) Share everything in turn (the share sheet takes one file at a time).
  for (const uri of [...exportUris, ...imageUris]) {
    await shareFile(uri);
  }

  return { exportUris, imageUris, receiptCount: receipts.length };
}
