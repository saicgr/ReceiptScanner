/**
 * Web SQLite shim.
 *
 * `expo-sqlite` has no web implementation, so in a browser we back the database
 * with `sql.js` (SQLite compiled to WebAssembly). This module exposes the small
 * slice of the `expo-sqlite` async API that our DAOs actually use:
 *
 *   openDatabaseAsync(name) -> { runAsync, getAllAsync, getFirstAsync,
 *                                execAsync, withTransactionAsync, closeAsync }
 *
 * sql.js is an in-memory engine, so we persist the serialized database to
 * IndexedDB after writes (debounced) and reload it on open, giving the web app
 * durable storage across reloads. This is a development/PWA convenience — the
 * native builds still use the real `expo-sqlite` native module.
 */
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

// Pin the wasm to the exact installed sql.js version so the JS/wasm pair match.
const SQL_JS_VERSION = '1.14.1';
const WASM_URL = `https://cdn.jsdelivr.net/npm/sql.js@${SQL_JS_VERSION}/dist/sql-wasm.wasm`;

type Params = unknown[] | Record<string, unknown> | undefined;
type Row = Record<string, unknown>;

export interface WebSQLiteDatabase {
  runAsync(source: string, params?: Params): Promise<{ lastInsertRowId: number; changes: number }>;
  getAllAsync<T = Row>(source: string, params?: Params): Promise<T[]>;
  getFirstAsync<T = Row>(source: string, params?: Params): Promise<T | null>;
  execAsync(source: string): Promise<void>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;
function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({ locateFile: () => WASM_URL });
  }
  return sqlJsPromise;
}

/* ----------------------------- IndexedDB I/O ----------------------------- */

const IDB_NAME = 'receiptsnap-sqlite';
const IDB_STORE = 'databases';

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbLoad(key: string): Promise<Uint8Array | null> {
  try {
    const idb = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbSave(key: string, bytes: Uint8Array): Promise<void> {
  try {
    const idb = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* best-effort persistence */
  }
}

/* ------------------------------ Param helpers ---------------------------- */

/**
 * Normalize the params our DAOs pass (always a positional array or omitted)
 * into a shape sql.js accepts. Values must be number | string | Uint8Array |
 * null — coerce `undefined` and booleans defensively.
 */
function normalizeParams(params: Params): (number | string | Uint8Array | null)[] | undefined {
  if (params == null) return undefined;
  const arr = Array.isArray(params) ? params : Object.values(params);
  return arr.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number' || typeof v === 'string' || v instanceof Uint8Array) return v;
    return String(v);
  });
}

/* ------------------------------ The database ----------------------------- */

export async function openDatabaseAsync(name: string): Promise<WebSQLiteDatabase> {
  const SQL = await getSqlJs();
  const saved = await idbLoad(name);
  const db: Database = saved ? new SQL.Database(saved) : new SQL.Database();

  // Debounced persistence so a burst of writes serializes to IndexedDB once.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persisting = false;
  const persist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      if (persisting) return;
      persisting = true;
      try {
        await idbSave(name, db.export());
      } finally {
        persisting = false;
      }
    }, 200);
  };

  const query = (source: string, params?: Params): Row[] => {
    const stmt = db.prepare(source);
    try {
      const bound = normalizeParams(params);
      if (bound && bound.length) stmt.bind(bound);
      const rows: Row[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as Row);
      return rows;
    } finally {
      stmt.free();
    }
  };

  return {
    async runAsync(source, params) {
      db.run(source, normalizeParams(params));
      const res = db.exec('SELECT last_insert_rowid() AS id, changes() AS ch');
      const v = res[0]?.values?.[0] ?? [0, 0];
      persist();
      return { lastInsertRowId: Number(v[0] ?? 0), changes: Number(v[1] ?? 0) };
    },

    async getAllAsync<T = Row>(source: string, params?: Params) {
      return query(source, params) as T[];
    },

    async getFirstAsync<T = Row>(source: string, params?: Params) {
      const rows = query(source, params);
      return (rows.length ? (rows[0] as T) : null);
    },

    async execAsync(source) {
      // Multi-statement DDL (migrations, schema). No params by contract.
      db.exec(source);
      persist();
    },

    async withTransactionAsync(task) {
      db.run('BEGIN');
      try {
        await task();
        db.run('COMMIT');
      } catch (e) {
        try {
          db.run('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw e;
      }
      persist();
    },

    async closeAsync() {
      await idbSave(name, db.export());
      db.close();
    },
  };
}
