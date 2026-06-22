/**
 * Native database opener — the real `expo-sqlite` module (iOS/Android).
 *
 * This is split into a platform file so Metro never bundles `expo-sqlite` into
 * the WEB bundle (its web build pulls in a `.wasm` worker we don't use — web
 * resolves `opener.web.ts` and the sql.js shim instead).
 */
import * as SQLite from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

export function openDatabaseAsync(name: string): Promise<SQLiteDatabase> {
  return SQLite.openDatabaseAsync(name);
}
