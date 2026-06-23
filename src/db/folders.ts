/**
 * Folder DAO — the file-manager-style organization layer.
 *
 * Folders nest (Client -> Project -> Trip) via a self-referential `parent_id`,
 * and label receipts MANY-TO-MANY through the `receipt_folders` join table. A
 * receipt placed in several folders is still ONE underlying record, so totals,
 * statistics and deductions never double-count — "add to folder" is a label, not
 * a copy. Folders are orthogonal to category/tax/payment metadata.
 */
import { getDb } from './database';
import { mapFolder, mapReceipt } from './mappers';
import { newId } from '../lib/id';
import type { Folder, FolderNode, Receipt } from '../types';

const NOW = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listFolders(): Promise<Folder[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM folders ORDER BY sort_order ASC, name ASC',
  );
  return rows.map(mapFolder);
}

/**
 * List folders directly under `parentId` (null = top level), decorated with the
 * child-folder count and the count of receipts labelled DIRECTLY into each.
 */
export async function listFolderNodes(
  parentId: string | null,
): Promise<FolderNode[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT f.*,
            (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS childCount,
            (SELECT COUNT(*) FROM receipt_folders rf WHERE rf.folder_id = f.id) AS receiptCount
     FROM folders f
     WHERE f.parent_id IS ?
     ORDER BY f.sort_order ASC, f.name ASC`,
    [parentId],
  );
  return rows.map((r) => ({
    ...mapFolder(r),
    childCount: Number(r.childCount ?? 0),
    receiptCount: Number(r.receiptCount ?? 0),
  }));
}

export async function getFolder(id: string): Promise<Folder | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM folders WHERE id = ?',
    [id],
  );
  return row ? mapFolder(row) : null;
}

export async function createFolder(input: Partial<Folder>): Promise<Folder> {
  const db = await getDb();
  const id = input.id ?? newId();
  const order =
    input.sort_order ??
    ((
      await db.getFirstAsync<{ n: number }>(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM folders WHERE parent_id IS ?',
        [input.parent_id ?? null],
      )
    )?.n ?? 0);
  await db.runAsync(
    'INSERT INTO folders (id, name, parent_id, color, icon, sort_order, created_at) VALUES (?,?,?,?,?,?,?)',
    [
      id,
      input.name ?? 'New Folder',
      input.parent_id ?? null,
      input.color ?? '#0E7C66',
      input.icon ?? 'folder',
      order,
      NOW(),
    ],
  );
  return (await getFolder(id))!;
}

export async function updateFolder(
  id: string,
  patch: Partial<Folder>,
): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const params: any[] = [];
  for (const k of ['name', 'color', 'icon', 'sort_order', 'parent_id'] as const) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      params.push(patch[k]);
    }
  }
  if (!fields.length) return;
  params.push(id);
  await db.runAsync(`UPDATE folders SET ${fields.join(', ')} WHERE id = ?`, params);
}

/**
 * Delete a folder. Child folders cascade (FK ON DELETE CASCADE) and the
 * receipt_folders labels cascade too — but the underlying RECEIPTS are untouched
 * because they live in their own table; only the labels disappear.
 */
export async function deleteFolder(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM folders WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Breadcrumb / ancestry
// ---------------------------------------------------------------------------

/** Root -> ... -> folder path for the breadcrumb (the folder itself is last). */
export async function folderPath(id: string): Promise<Folder[]> {
  const path: Folder[] = [];
  let current = await getFolder(id);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    path.unshift(current);
    current = current.parent_id ? await getFolder(current.parent_id) : null;
  }
  return path;
}

/** All descendant folder ids (inclusive of `id`) — used for "all in subtree". */
export async function descendantFolderIds(id: string): Promise<string[]> {
  const all = await listFolders();
  const childrenOf = new Map<string | null, string[]>();
  for (const f of all) {
    const list = childrenOf.get(f.parent_id) ?? [];
    list.push(f.id);
    childrenOf.set(f.parent_id, list);
  }
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    for (const child of childrenOf.get(cur) ?? []) stack.push(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Membership (many-to-many labels)
// ---------------------------------------------------------------------------

/** Add a receipt label to a folder (idempotent). */
export async function addReceiptToFolder(
  receiptId: string,
  folderId: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT OR IGNORE INTO receipt_folders (receipt_id, folder_id, added_at) VALUES (?,?,?)',
    [receiptId, folderId, NOW()],
  );
}

/** Remove a receipt label from a folder (the receipt itself stays). */
export async function removeReceiptFromFolder(
  receiptId: string,
  folderId: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM receipt_folders WHERE receipt_id = ? AND folder_id = ?',
    [receiptId, folderId],
  );
}

/** Move (label) many receipts into a folder at once (bulk move/add). */
export async function addReceiptsToFolder(
  receiptIds: string[],
  folderId: string,
): Promise<void> {
  if (!receiptIds.length) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const rid of receiptIds) {
      await db.runAsync(
        'INSERT OR IGNORE INTO receipt_folders (receipt_id, folder_id, added_at) VALUES (?,?,?)',
        [rid, folderId, NOW()],
      );
    }
  });
}

/**
 * A true MOVE: relabel receipts from one folder to another (remove the old
 * label, add the new). Passing `fromFolderId = null` only adds the new label.
 */
export async function moveReceiptsToFolder(
  receiptIds: string[],
  toFolderId: string,
  fromFolderId: string | null,
): Promise<void> {
  if (!receiptIds.length) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const rid of receiptIds) {
      if (fromFolderId) {
        await db.runAsync(
          'DELETE FROM receipt_folders WHERE receipt_id = ? AND folder_id = ?',
          [rid, fromFolderId],
        );
      }
      await db.runAsync(
        'INSERT OR IGNORE INTO receipt_folders (receipt_id, folder_id, added_at) VALUES (?,?,?)',
        [rid, toFolderId, NOW()],
      );
    }
  });
}

/** Folder ids a given receipt is currently labelled into. */
export async function foldersForReceipt(receiptId: string): Promise<Folder[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT f.* FROM folders f
     JOIN receipt_folders rf ON rf.folder_id = f.id
     WHERE rf.receipt_id = ?
     ORDER BY f.name ASC`,
    [receiptId],
  );
  return rows.map(mapFolder);
}

/**
 * Receipts labelled into a folder. When `includeSubfolders` is true, receipts in
 * any descendant folder are included too (de-duplicated, so a receipt in both a
 * parent and child folder still appears once — never double-counted).
 */
export async function listReceiptsInFolder(
  folderId: string,
  includeSubfolders = false,
): Promise<Receipt[]> {
  const db = await getDb();
  const ids = includeSubfolders
    ? await descendantFolderIds(folderId)
    : [folderId];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.getAllAsync<any>(
    `SELECT DISTINCT r.* FROM receipts r
     JOIN receipt_folders rf ON rf.receipt_id = r.id
     WHERE rf.folder_id IN (${placeholders})
     ORDER BY r.date DESC, r.created_at DESC`,
    ids,
  );
  return rows.map(mapReceipt);
}

/** Set the exact set of folders a receipt belongs to (used by the picker). */
export async function setReceiptFolders(
  receiptId: string,
  folderIds: string[],
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM receipt_folders WHERE receipt_id = ?', [
      receiptId,
    ]);
    for (const fid of folderIds) {
      await db.runAsync(
        'INSERT OR IGNORE INTO receipt_folders (receipt_id, folder_id, added_at) VALUES (?,?,?)',
        [receiptId, fid, NOW()],
      );
    }
  });
}
