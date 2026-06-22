/** Tag DAO. Tags group receipts by trip or job for filtering and export. */
import { getDb } from './database';
import { mapTag } from './mappers';
import { newId } from '../lib/id';
import type { Tag } from '../types';

export async function listTags(): Promise<Tag[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>('SELECT * FROM tags ORDER BY name ASC');
  return rows.map(mapTag);
}

export async function createTag(input: Partial<Tag>): Promise<Tag> {
  const db = await getDb();
  const id = input.id ?? newId();
  await db.runAsync(
    'INSERT INTO tags (id, name, color, kind) VALUES (?,?,?,?)',
    [id, input.name ?? 'New Tag', input.color ?? '#64748B', input.kind ?? 'tag'],
  );
  const row = await db.getFirstAsync<any>('SELECT * FROM tags WHERE id = ?', [
    id,
  ]);
  return mapTag(row);
}

export async function updateTag(id: string, patch: Partial<Tag>): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const params: any[] = [];
  for (const k of ['name', 'color', 'kind'] as const) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      params.push(patch[k]);
    }
  }
  if (!fields.length) return;
  params.push(id);
  await db.runAsync(`UPDATE tags SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function deleteTag(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM tags WHERE id = ?', [id]);
}

/** Find-or-create a tag by name (used by importers / quick add). */
export async function ensureTag(
  name: string,
  kind: Tag['kind'] = 'tag',
): Promise<Tag> {
  const db = await getDb();
  const existing = await db.getFirstAsync<any>(
    'SELECT * FROM tags WHERE name = ? COLLATE NOCASE',
    [name],
  );
  if (existing) return mapTag(existing);
  return createTag({ name, kind });
}
