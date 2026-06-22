/**
 * Web database opener — backed by the `sql.js` (WASM) shim. Metro resolves this
 * `.web.ts` variant for the web bundle, so `expo-sqlite` (and its wasm worker)
 * is never imported on web. The `SQLiteDatabase` type import is type-only and
 * erased at build time, so it does not pull the native module into the bundle.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { openDatabaseAsync as openWebDatabaseAsync } from './sqliteWeb';

export function openDatabaseAsync(name: string): Promise<SQLiteDatabase> {
  // The shim implements the subset of the expo-sqlite API our DAOs use.
  return openWebDatabaseAsync(name) as unknown as Promise<SQLiteDatabase>;
}
