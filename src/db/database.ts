/**
 * SQLite connection + migration runner.
 *
 * `getDb()` lazily opens a single shared connection, enables foreign keys and
 * WAL, runs any pending migrations (driven by PRAGMA user_version) and seeds
 * defaults on first run. All DAO modules call `getDb()`.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { openDatabaseAsync } from './opener';
import { MIGRATIONS, LATEST_VERSION } from './migrations';
import { seedDefaults } from './seed';

const DB_NAME = 'receiptsnap.db';

// The raw underlying connection. May be transparently replaced if it gets
// released out from under us (see withReconnect).
let rawDbPromise: Promise<SQLiteDatabase> | null = null;

function getRawDb(): Promise<SQLiteDatabase> {
  if (!rawDbPromise) {
    // Clear the cache if opening fails so the next call retries instead of
    // caching a rejected promise forever.
    rawDbPromise = openAndPrepare().catch((e) => {
      rawDbPromise = null;
      throw e;
    });
  }
  return rawDbPromise;
}

/**
 * True for the native expo-sqlite errors that mean the underlying connection or
 * statement is no longer usable — typically after a Fast Refresh or an app
 * background/release on the new architecture ("Cannot use shared object that
 * was already released", a NativeStatement/NativeDatabase cast failure, etc.).
 */
function isReleasedError(e: unknown): boolean {
  const msg = String((e as { message?: string } | null)?.message ?? e);
  return /already released|NativeStatement|NativeDatabase|released object|has been rejected/i.test(msg);
}

/**
 * Run a database operation, transparently reopening the connection ONCE if it
 * fails because the underlying native object was released. This keeps the app
 * alive across hot reloads / lifecycle releases instead of crashing every query.
 */
async function withReconnect<T>(op: (db: SQLiteDatabase) => Promise<T>): Promise<T> {
  try {
    return await op(await getRawDb());
  } catch (e) {
    if (!isReleasedError(e)) throw e;
    // Drop the dead handle and reopen against a fresh connection, then retry.
    rawDbPromise = null;
    return await op(await getRawDb());
  }
}

/**
 * A stable database facade returned by getDb(). It forwards the subset of the
 * expo-sqlite async API our DAOs use to the *current* live connection, so even
 * when that connection is replaced (reconnect after a release) callers holding
 * this object keep working. Both engines — native expo-sqlite and the web
 * sql.js shim — implement these methods.
 */
const dbFacade = {
  runAsync: (...a: unknown[]) => withReconnect((db) => (db.runAsync as (...x: unknown[]) => Promise<unknown>)(...a)),
  getAllAsync: (...a: unknown[]) => withReconnect((db) => (db.getAllAsync as (...x: unknown[]) => Promise<unknown>)(...a)),
  getFirstAsync: (...a: unknown[]) => withReconnect((db) => (db.getFirstAsync as (...x: unknown[]) => Promise<unknown>)(...a)),
  execAsync: (...a: unknown[]) => withReconnect((db) => (db.execAsync as (...x: unknown[]) => Promise<unknown>)(...a)),
  withTransactionAsync: (...a: unknown[]) => withReconnect((db) => (db.withTransactionAsync as (...x: unknown[]) => Promise<unknown>)(...a)),
  closeAsync: async () => {
    const p = rawDbPromise;
    rawDbPromise = null;
    if (!p) return;
    try {
      await (await p).closeAsync();
    } catch {
      /* already gone */
    }
  },
} as unknown as SQLiteDatabase;

export function getDb(): Promise<SQLiteDatabase> {
  return Promise.resolve(dbFacade);
}

async function openAndPrepare(): Promise<SQLiteDatabase> {
  // The engine is chosen by a platform-resolved opener module: the real
  // `expo-sqlite` native module on iOS/Android (opener.ts), or the sql.js WASM
  // shim on web (opener.web.ts). Metro picks the right file, so `expo-sqlite`
  // never enters the web bundle.
  const db = await openDatabaseAsync(DB_NAME);

  // Pragmas: enforce FK constraints, use WAL for concurrent reads.
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');

  await runMigrations(db);
  await maybeSeed(db);

  return db;
}

async function runMigrations(db: SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version;',
  );
  let version = row?.user_version ?? 0;

  for (let i = version; i < LATEST_VERSION; i++) {
    await MIGRATIONS[i](db);
    version = i + 1;
    // PRAGMA can't be parameterized; version is an int we control.
    await db.execAsync(`PRAGMA user_version = ${version};`);
  }
}

async function maybeSeed(db: SQLiteDatabase): Promise<void> {
  const seeded = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    ['seeded'],
  );
  if (seeded?.value === '1') return;

  // Only seed if there genuinely are no categories yet (defensive for upgrades).
  const count = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) as n FROM categories',
  );
  if ((count?.n ?? 0) === 0) {
    await seedDefaults(db);
  }
  await db.runAsync(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    ['seeded', '1'],
  );
}

/**
 * Close + reset the cached connection. Used by tests and by backup/restore:
 * the restore flow MUST close the live handle before swapping the db file on
 * disk (overwriting an open WAL-mode database risks corruption), then the next
 * `getDb()` reopens against the restored file. A rejected `dbPromise` (e.g. a
 * corrupt restored file failing to open) is also cleared here so `getDb()` can
 * retry instead of caching the failure forever.
 */
export async function resetConnection(): Promise<void> {
  const p = rawDbPromise;
  rawDbPromise = null;
  if (!p) return;
  try {
    await (await p).closeAsync();
  } catch {
    /* ignore */
  }
}

/** Boolean <-> INTEGER helpers used across DAOs. */
export const toInt = (b: boolean): number => (b ? 1 : 0);
export const toBool = (n: number | null | undefined): boolean => n === 1;
