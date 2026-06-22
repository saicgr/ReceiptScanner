/**
 * Typed key/value settings store. Settings persist in the `settings` table as
 * strings; this module serializes/deserializes and merges with DEFAULT_SETTINGS
 * so reads always return a fully-populated, typed AppSettings object.
 */
import { getDb } from './database';
import { DEFAULT_SETTINGS, type AppSettings } from '../types';

type SettingKey = keyof AppSettings;

function serialize(value: AppSettings[SettingKey]): string {
  return JSON.stringify(value);
}

function deserialize<K extends SettingKey>(
  key: K,
  raw: string | null | undefined,
): AppSettings[K] {
  if (raw == null) return DEFAULT_SETTINGS[key];
  try {
    return JSON.parse(raw) as AppSettings[K];
  } catch {
    return DEFAULT_SETTINGS[key];
  }
}

export async function getAllSettings(): Promise<AppSettings> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    'SELECT key, value FROM settings',
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
    if (map.has(key)) {
      (out as any)[key] = deserialize(key, map.get(key));
    }
  }
  return out;
}

export async function getSetting<K extends SettingKey>(
  key: K,
): Promise<AppSettings[K]> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [key],
  );
  return deserialize(key, row?.value);
}

export async function setSetting<K extends SettingKey>(
  key: K,
  value: AppSettings[K],
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    [key, serialize(value)],
  );
}

export async function updateSettings(
  patch: Partial<AppSettings>,
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const [key, value] of Object.entries(patch)) {
      await db.runAsync(
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        [key, serialize(value as AppSettings[SettingKey])],
      );
    }
  });
}

/**
 * Atomic counter increment for scan-count gating. A single upsert statement —
 * not a read-modify-write — so concurrent persists (e.g. a Multi-Scan batch)
 * can never interleave and lose a count. Settings values are JSON-encoded, but
 * an integer's JSON form IS its text form, so CAST round-trips it safely.
 * Returns the new value.
 */
export async function incrementScanCount(): Promise<number> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('scan_count', ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    [serialize(DEFAULT_SETTINGS.scan_count + 1)],
  );
  return getSetting('scan_count');
}
