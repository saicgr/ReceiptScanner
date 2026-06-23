/**
 * folderExport — point-in-time export of a folder/project as a shareable bundle.
 *
 * A "bundle" is generated entirely on-device (NO server): we collect every
 * receipt currently labelled into the folder (optionally including its
 * subfolders, de-duplicated so a receipt in both parent and child appears once),
 * then write a self-contained CSV and a browse-anywhere HTML report and hand
 * each to the OS share sheet in turn. The user can route those to Drive/OneDrive
 * or any other app from the sheet.
 *
 * Because folders are a label layer over the single underlying receipt, the
 * bundle reflects exactly what the folder shows — and never double-counts a
 * receipt that lives in multiple folders.
 */
import * as DB from '@/db';
import type { AccountingFormat, ReceiptWithRelations } from '@/types';
import { exportReceiptList, shareFile } from './exporters';

/** Filesystem-safe stem from the folder name (so the shared file reads well). */
function safeStem(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug ? `folder-${slug}` : 'folder';
}

/** Load the folder's receipts WITH relations (line items, tags, images). */
async function loadFolderReceipts(
  folderId: string,
  includeSubfolders: boolean,
): Promise<ReceiptWithRelations[]> {
  const base = await DB.Folders.listReceiptsInFolder(folderId, includeSubfolders);
  const out: ReceiptWithRelations[] = [];
  for (const r of base) {
    const full = await DB.getReceipt(r.id);
    if (full) out.push(full);
  }
  return out;
}

/**
 * Export a folder as a bundle of files in `formats` (defaults to a CSV + an
 * HTML report) and share each. Returns the written file uris. Throws if the
 * folder is empty so the caller can surface a helpful message.
 */
export async function exportFolderBundle(
  folderId: string,
  opts?: { includeSubfolders?: boolean; formats?: AccountingFormat[] },
): Promise<string[]> {
  const includeSubfolders = opts?.includeSubfolders ?? true;
  const formats = opts?.formats ?? ['csv', 'html'];

  const folder = await DB.Folders.getFolder(folderId);
  const receipts = await loadFolderReceipts(folderId, includeSubfolders);
  if (receipts.length === 0) {
    throw new Error('empty-folder');
  }

  const stem = safeStem(folder?.name ?? 'folder');
  const uris: string[] = [];
  for (const format of formats) {
    const uri = await exportReceiptList(format, receipts, stem);
    uris.push(uri);
  }

  // Share each generated file in turn (the share sheet handles one file each).
  for (const uri of uris) {
    await shareFile(uri);
  }
  return uris;
}
