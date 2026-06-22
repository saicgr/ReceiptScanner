/**
 * backupService — Backup / restore the local SQLite database AND the receipt
 * images to the USER'S OWN cloud storage (Google Drive or OneDrive). There is
 * NO ReceiptSnap server in this flow: we OAuth straight against Google /
 * Microsoft and push the files into the signed-in user's own Drive. The app
 * never sees or stores the user's receipts on our infrastructure.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *  1. `expo-auth-session` runs the OAuth 2.0 Authorization-Code + PKCE flow in a
 *     system browser, returning an access token scoped to a per-app folder
 *     (Drive `drive.file` / OneDrive `Files.ReadWrite.AppFolder`). The token is
 *     held only in memory for the duration of the backup/restore.
 *  2. Backup: the WAL is checkpointed into the main db file (the app runs
 *     SQLite in WAL mode, so without this the newest transactions would live in
 *     `receiptsnap.db-wal` and be MISSING from the backup), then
 *     `receiptsnap.db` is uploaded. Every image in the `receipts/` documents
 *     dir is uploaded INDIVIDUALLY (by filename) into a `receiptsnap_images`
 *     folder — incrementally: files whose name+size already match the cloud
 *     copy are skipped. A small JSON manifest inventorying the image set is
 *     uploaded alongside.
 *  3. Restore: the cloud db is downloaded to a TEMP file first, then the live
 *     connection is closed, the current db is parked as `receiptsnap.db.bak`,
 *     stale `-wal`/`-shm` sidecars are deleted (pairing a new db with an old
 *     journal corrupts or silently rolls it back), the download is swapped in
 *     and verified with `PRAGMA integrity_check`. On verification failure the
 *     .bak is restored — the user's existing data is never lost. On success the
 *     images are downloaded back into `receipts/` and the absolute image uris
 *     stored in the db are re-pointed at THIS install's receipts dir (sandbox
 *     paths change between installs/devices).
 *
 * ── Setup (documented for the app maintainer) ───────────────────────────────
 *  - Google: create an OAuth client (iOS / Android / Web) in Google Cloud
 *    Console, enable the Drive API, and put the client ids in app.json `extra`
 *    (`googleOAuthClientId{Ios,Android,Web}`). Scope used: drive.file.
 *  - Microsoft: register an app in Entra (Azure AD), enable the
 *    `Files.ReadWrite.AppFolder` delegated permission, set the redirect URI to
 *    the Expo proxy / app scheme, and put the client id in app.json `extra`
 *    (`microsoftOAuthClientId`). Multi-tenant + personal accounts → /common.
 *
 * If the relevant client ids are still placeholders (empty), every public
 * function degrades gracefully and returns `{ ok: false, message }` — it never
 * throws and never blocks the UI. All provider calls are wrapped in try/catch.
 */
import * as AuthSession from 'expo-auth-session';
import * as FileSystem from 'expo-file-system/legacy';

import { getDb, resetConnection } from '@/db';
import { appConfig } from '@/lib/config';
import { useSettings } from '@/store/settings';
import type { CloudProvider } from '@/types';
import { RECEIPTS_DIR } from './imagePipeline';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute path to the live SQLite database file expo-sqlite manages. */
const DB_PATH = `${FileSystem.documentDirectory}SQLite/receiptsnap.db`;

/** WAL-mode sidecar files. Must be removed when swapping in a restored db so
 *  the new main file is never paired with the OLD journal. */
const DB_WAL_PATH = `${DB_PATH}-wal`;
const DB_SHM_PATH = `${DB_PATH}-shm`;

/** Where the current db is parked during a restore until the download passes
 *  `PRAGMA integrity_check` — the rollback copy on verification failure. */
const DB_BAK_PATH = `${DB_PATH}.bak`;

/** The filename we write into the user's cloud. */
const BACKUP_FILENAME = 'receiptsnap.db';

/** Cloud folder holding one file per receipt image (named by local filename). */
const IMAGES_FOLDER = 'receiptsnap_images';

/** JSON inventory of the backed-up image set, uploaded next to the db. */
const MANIFEST_FILENAME = 'receiptsnap-manifest.json';

/** Google Drive OAuth + REST endpoints. */
const GOOGLE = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  scopes: ['https://www.googleapis.com/auth/drive.file'],
  uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files',
  filesUrl: 'https://www.googleapis.com/drive/v3/files',
  folderMime: 'application/vnd.google-apps.folder',
};

/** Microsoft Graph (OneDrive) OAuth + REST endpoints. Personal + work accts. */
const MICROSOFT = {
  authorizationEndpoint:
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: ['Files.ReadWrite.AppFolder', 'offline_access'],
  // Upload into the per-app special folder so we never touch the user's other files.
  appRootUrl: 'https://graph.microsoft.com/v1.0/me/drive/special/approot',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Progress callback so the Backup screen can narrate multi-file operations. */
export type BackupProgress = (message: string) => void;

/** A file in the local `receipts/` dir (name is the backup-relative key). */
interface LocalImage {
  name: string;
  size: number;
  uri: string;
}

/** A file in the cloud images folder. `id` is Drive-only (Graph uses paths). */
interface RemoteFile {
  id: string | null;
  name: string;
  size: number;
}

/** The JSON inventory uploaded alongside the db. Restore prefers the live
 *  cloud-folder listing; the manifest is the fallback (and documentation). */
interface BackupManifest {
  version: 1;
  created_at: string;
  db_filename: string;
  images: { name: string; size: number }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect an unconfigured (placeholder/empty) OAuth client id. */
function isPlaceholder(value: string | undefined | null): boolean {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  return v === '' || v.includes('your-') || v.includes('placeholder') || v === 'changeme';
}

/**
 * Pick the most appropriate Google client id for the running platform. Falls
 * back across ios → android → web so a single configured id still works.
 */
function googleClientId(): string {
  const g = appConfig.google;
  const candidates = [g.iosClientId, g.androidClientId, g.webClientId];
  for (const c of candidates) {
    if (!isPlaceholder(c)) return c;
  }
  return '';
}

/** Build the redirect URI expo-auth-session will round-trip through. */
function makeRedirectUri(): string {
  // `useProxy` keeps Expo Go working; standalone builds use the app scheme.
  return AuthSession.makeRedirectUri({ scheme: 'receiptsnap' });
}

/** A friendly message wrapping an unknown thrown value. */
function errMessage(prefix: string, e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  return `${prefix}: ${detail}`;
}

/** Confirm the local sqlite file exists before we try to upload it. */
async function dbFileExists(): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(DB_PATH);
    return info.exists && !info.isDirectory;
  } catch {
    return false;
  }
}

/** Delete a file if it exists; never throws (idempotent by design). */
async function deleteIfExists(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort: a stale file we couldn't delete surfaces later as a real
    // error from whichever operation actually needs the path.
  }
}

/**
 * Fold the WAL into the main db file on the LIVE connection. The app runs
 * SQLite in WAL mode (see src/db/database.ts), so recent transactions live in
 * `receiptsnap.db-wal` until a checkpoint — uploading only the .db without
 * this would silently drop them from the backup.
 */
async function checkpointWal(): Promise<void> {
  try {
    const db = await getDb();
    await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    try {
      // TRUNCATE can fail if a reader holds the WAL open; FULL still copies
      // every frame into the main file, which is all the backup needs.
      const db = await getDb();
      await db.execAsync('PRAGMA wal_checkpoint(FULL);');
    } catch {
      // Best-effort: an un-checkpointed file is still a valid database — it
      // just misses the newest transactions. Don't block the backup over it.
    }
  }
}

/** Enumerate the local `receipts/` images with their sizes. Never throws. */
async function listLocalImages(): Promise<LocalImage[]> {
  try {
    const dirInfo = await FileSystem.getInfoAsync(RECEIPTS_DIR);
    if (!dirInfo.exists) return [];
    const names = await FileSystem.readDirectoryAsync(RECEIPTS_DIR);
    const out: LocalImage[] = [];
    for (const name of names) {
      const uri = `${RECEIPTS_DIR}${name}`;
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists && !info.isDirectory) {
          out.push({ name, size: (info as { size?: number }).size ?? 0, uri });
        }
      } catch {
        // Unreadable entry — skip it rather than fail the whole backup.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Ensure the `receipts/` dir exists before downloading images into it. */
async function ensureReceiptsDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(RECEIPTS_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(RECEIPTS_DIR, { intermediates: true });
    }
  } catch {
    // Best-effort; downloadAsync will surface a real error if the dir is bad.
  }
}

/**
 * Re-point absolute image uris at THIS install's receipts dir. The db stores
 * absolute `file://` uris, but the app sandbox path changes between installs
 * and devices, so after a restore every `.../receipts/<name>` reference is
 * rewritten to `${RECEIPTS_DIR}<name>` — the filename is the stable,
 * backup-relative key. Uris already under the current dir are left alone.
 */
async function relinkImagePaths(): Promise<void> {
  const db = await getDb();
  const marker = '/receipts/';
  const targets: [table: string, column: string][] = [
    ['receipts', 'original_image_uri'],
    ['receipt_images', 'uri'],
    ['line_items', 'product_photo_uri'],
  ];
  for (const [table, column] of targets) {
    try {
      await db.runAsync(
        `UPDATE ${table}
            SET ${column} = ? || substr(${column}, instr(${column}, ?) + length(?))
          WHERE ${column} LIKE ? AND ${column} NOT LIKE ?`,
        [RECEIPTS_DIR, marker, marker, `%${marker}%`, `${RECEIPTS_DIR}%`],
      );
    } catch {
      // Non-fatal: an unlinked image shows the fallback thumbnail, not a crash.
    }
  }
}

/**
 * Run the OAuth Authorization-Code + PKCE flow for a provider and exchange the
 * code for an access token. Returns `null` on any failure / user-cancel so the
 * caller can degrade gracefully. Never throws.
 */
async function authorize(
  provider: CloudProvider,
): Promise<{ accessToken: string } | { error: string }> {
  try {
    const redirectUri = makeRedirectUri();

    if (provider === 'google_drive') {
      const clientId = googleClientId();
      if (isPlaceholder(clientId)) {
        return { error: 'Configure OAuth client id in app.json' };
      }
      const discovery = {
        authorizationEndpoint: GOOGLE.authorizationEndpoint,
        tokenEndpoint: GOOGLE.tokenEndpoint,
      };
      const request = new AuthSession.AuthRequest({
        clientId,
        scopes: GOOGLE.scopes,
        redirectUri,
        usePKCE: true,
        // `consent` so Drive scope is re-granted reliably across re-installs.
        extraParams: { access_type: 'offline', prompt: 'consent' },
      });
      const result = await request.promptAsync(discovery);
      if (result.type !== 'success' || !result.params.code) {
        return { error: result.type === 'success' ? 'No authorization code returned' : 'Sign-in cancelled' };
      }
      const token = await AuthSession.exchangeCodeAsync(
        {
          clientId,
          code: result.params.code,
          redirectUri,
          extraParams: request.codeVerifier
            ? { code_verifier: request.codeVerifier }
            : {},
        },
        discovery,
      );
      if (!token.accessToken) return { error: 'Token exchange failed' };
      return { accessToken: token.accessToken };
    }

    // ── OneDrive / Microsoft Graph ──
    const clientId = appConfig.microsoftClientId;
    if (isPlaceholder(clientId)) {
      return { error: 'Configure OAuth client id in app.json' };
    }
    const discovery = {
      authorizationEndpoint: MICROSOFT.authorizationEndpoint,
      tokenEndpoint: MICROSOFT.tokenEndpoint,
    };
    const request = new AuthSession.AuthRequest({
      clientId,
      scopes: MICROSOFT.scopes,
      redirectUri,
      usePKCE: true,
    });
    const result = await request.promptAsync(discovery);
    if (result.type !== 'success' || !result.params.code) {
      return { error: result.type === 'success' ? 'No authorization code returned' : 'Sign-in cancelled' };
    }
    const token = await AuthSession.exchangeCodeAsync(
      {
        clientId,
        code: result.params.code,
        redirectUri,
        extraParams: request.codeVerifier
          ? { code_verifier: request.codeVerifier }
          : {},
      },
      discovery,
    );
    if (!token.accessToken) return { error: 'Token exchange failed' };
    return { accessToken: token.accessToken };
  } catch (e) {
    return { error: errMessage('Authorization failed', e) };
  }
}

// ---------------------------------------------------------------------------
// Google Drive transport
// ---------------------------------------------------------------------------

/** Escape a filename for embedding in a Drive `q` query string. */
function googleEscape(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Find a file by name (optionally within a parent), newest first. */
async function googleFindByName(
  accessToken: string,
  name: string,
  parentId?: string,
): Promise<{ id: string; size: number } | null> {
  const terms = [`name='${googleEscape(name)}'`, 'trashed=false'];
  if (parentId) terms.push(`'${parentId}' in parents`);
  const q = encodeURIComponent(terms.join(' and '));
  const res = await fetch(
    `${GOOGLE.filesUrl}?q=${q}&spaces=drive&fields=files(id,size,modifiedTime)&orderBy=modifiedTime desc&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { files?: { id: string; size?: string }[] };
  const file = json.files?.[0];
  return file ? { id: file.id, size: Number(file.size ?? 0) } : null;
}

/** Find a previously-uploaded backup db file id in the user's Drive, if any. */
async function googleFindBackup(accessToken: string): Promise<string | null> {
  const found = await googleFindByName(accessToken, BACKUP_FILENAME);
  return found?.id ?? null;
}

/** Find the images folder by name; returns null when it doesn't exist yet. */
async function googleFindFolder(
  accessToken: string,
  name: string,
): Promise<string | null> {
  const q = encodeURIComponent(
    `name='${googleEscape(name)}' and mimeType='${GOOGLE.folderMime}' and trashed=false`,
  );
  const res = await fetch(
    `${GOOGLE.filesUrl}?q=${q}&spaces=drive&fields=files(id)&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { files?: { id: string }[] };
  return json.files?.[0]?.id ?? null;
}

/** Find-or-create the images folder (used by backup; restore is find-only). */
async function googleEnsureFolder(
  accessToken: string,
  name: string,
): Promise<string> {
  const existing = await googleFindFolder(accessToken, name);
  if (existing) return existing;
  const res = await fetch(GOOGLE.filesUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, mimeType: GOOGLE.folderMime }),
  });
  if (!res.ok) {
    throw new Error(`Drive folder HTTP ${res.status}: ${await safeBody(res)}`);
  }
  const json = (await res.json()) as { id: string };
  return json.id;
}

/** List every file in a Drive folder (paginated) with name + size. */
async function googleListChildren(
  accessToken: string,
  folderId: string,
): Promise<RemoteFile[]> {
  const out: RemoteFile[] = [];
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  let pageToken: string | null = null;
  do {
    const tokenParam: string = pageToken ? `&pageToken=${pageToken}` : '';
    const res = await fetch(
      `${GOOGLE.filesUrl}?q=${q}&spaces=drive&fields=nextPageToken,files(id,name,size)&pageSize=1000${tokenParam}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) {
      throw new Error(`Drive list HTTP ${res.status}: ${await safeBody(res)}`);
    }
    const json = (await res.json()) as {
      nextPageToken?: string;
      files?: { id: string; name: string; size?: string }[];
    };
    for (const f of json.files ?? []) {
      out.push({ id: f.id, name: f.name, size: Number(f.size ?? 0) });
    }
    pageToken = json.nextPageToken ?? null;
  } while (pageToken);
  return out;
}

/**
 * Upload (create or update) a local file to Google Drive. PATCHes the media of
 * `existingId` when given, otherwise creates via multipart (metadata + media).
 */
async function googleUploadFile(
  accessToken: string,
  localUri: string,
  name: string,
  opts: { parents?: string[]; existingId?: string | null } = {},
): Promise<string> {
  const base64 = await FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  if (opts.existingId) {
    // Update existing file content (media upload, PATCH).
    // Convert base64 → binary for the upload body (RN runtime has atob).
    const binary = base64ToBytes(base64);
    const res = await fetch(
      `${GOOGLE.uploadUrl}/${opts.existingId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body: binary as unknown as BodyInit,
      },
    );
    if (!res.ok) {
      throw new Error(`Drive update HTTP ${res.status}: ${await safeBody(res)}`);
    }
    return opts.existingId;
  }

  // Create a new file with a multipart upload (metadata + media).
  const boundary = 'receiptsnap-' + Date.now();
  const metadata = JSON.stringify(
    opts.parents ? { name, parents: opts.parents } : { name },
  );
  const head =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/octet-stream\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n';
  const tail = `\r\n--${boundary}--`;
  const multipartBody = head + base64 + tail;

  const res = await fetch(`${GOOGLE.uploadUrl}?uploadType=multipart`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });
  if (!res.ok) {
    throw new Error(`Drive create HTTP ${res.status}: ${await safeBody(res)}`);
  }
  const json = (await res.json()) as { id: string };
  return json.id;
}

/** Download a Drive file's content to a local destination path. */
async function googleDownloadToFile(
  accessToken: string,
  fileId: string,
  destUri: string,
): Promise<void> {
  const downloadUrl = `${GOOGLE.filesUrl}/${fileId}?alt=media`;
  const result = await FileSystem.downloadAsync(downloadUrl, destUri, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (result.status !== 200) {
    throw new Error(`Drive download HTTP ${result.status}`);
  }
}

// ---------------------------------------------------------------------------
// OneDrive (Microsoft Graph) transport
// ---------------------------------------------------------------------------

/** Encode a path under the app root (each segment separately, `/` kept). */
function onedrivePath(remotePath: string): string {
  return remotePath.split('/').map(encodeURIComponent).join('/');
}

/**
 * Upload a local file into the OneDrive app folder at `remotePath` (simple PUT,
 * which caps at ~4MB — receipt JPEGs at our enhance settings stay well under;
 * larger files fail per-file and are reported as failed, never thrown).
 * Intermediate folders in the path are created automatically by Graph.
 */
async function onedriveUploadFile(
  accessToken: string,
  localUri: string,
  remotePath: string,
): Promise<string> {
  const base64 = await FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const binary = base64ToBytes(base64);
  const url = `${MICROSOFT.appRootUrl}:/${onedrivePath(remotePath)}:/content`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
    },
    body: binary as unknown as BodyInit,
  });
  if (!res.ok) {
    throw new Error(`OneDrive upload HTTP ${res.status}: ${await safeBody(res)}`);
  }
  const json = (await res.json()) as { id?: string };
  return json.id ?? remotePath;
}

/** List a folder under the app root (paginated). 404 → empty (no folder yet). */
async function onedriveListChildren(
  accessToken: string,
  folder: string,
): Promise<RemoteFile[]> {
  const out: RemoteFile[] = [];
  let url: string | null =
    `${MICROSOFT.appRootUrl}:/${onedrivePath(folder)}:/children?$select=id,name,size&$top=200`;
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) return out; // folder never created — no images yet
    if (!res.ok) {
      throw new Error(`OneDrive list HTTP ${res.status}: ${await safeBody(res)}`);
    }
    const json = (await res.json()) as {
      value?: { id: string; name: string; size?: number }[];
      '@odata.nextLink'?: string;
    };
    for (const f of json.value ?? []) {
      out.push({ id: f.id, name: f.name, size: f.size ?? 0 });
    }
    url = json['@odata.nextLink'] ?? null;
  }
  return out;
}

/** Download an app-root file to a local destination. Throws on 404/missing. */
async function onedriveDownloadToFile(
  accessToken: string,
  remotePath: string,
  destUri: string,
): Promise<void> {
  const url = `${MICROSOFT.appRootUrl}:/${onedrivePath(remotePath)}:/content`;
  const result = await FileSystem.downloadAsync(url, destUri, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (result.status === 404) throw new Error('No backup found in OneDrive');
  if (result.status !== 200) {
    throw new Error(`OneDrive download HTTP ${result.status}`);
  }
}

// ---------------------------------------------------------------------------
// Image sync (provider-agnostic orchestration)
// ---------------------------------------------------------------------------

/**
 * Upload the local `receipts/` images, skipping files whose name+size already
 * match the cloud copy (incremental — repeat backups only pay for what's new).
 * Per-file failures are counted, never thrown, so one bad image can't sink the
 * whole backup. Finishes by uploading the manifest inventory.
 */
async function syncImagesToCloud(
  provider: CloudProvider,
  accessToken: string,
  onProgress?: BackupProgress,
): Promise<{ uploaded: number; skipped: number; failed: number; total: number }> {
  const images = await listLocalImages();
  const counts = { uploaded: 0, skipped: 0, failed: 0, total: images.length };

  let folderId: string | null = null;
  let remote: RemoteFile[] = [];
  if (provider === 'google_drive') {
    try {
      folderId = await googleEnsureFolder(accessToken, IMAGES_FOLDER);
    } catch {
      // Without the folder we cannot place images correctly; report them all
      // as failed rather than scattering files into the user's Drive root.
      counts.failed = images.length;
      return counts;
    }
    try {
      remote = await googleListChildren(accessToken, folderId);
    } catch {
      // Listing failed — re-upload everything (safe, just not incremental).
    }
  } else {
    try {
      remote = await onedriveListChildren(accessToken, IMAGES_FOLDER);
    } catch {
      // Same: PUT-by-path overwrites, so a failed listing only costs bandwidth.
    }
  }
  const remoteByName = new Map(remote.map((r) => [r.name, r]));

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const existing = remoteByName.get(img.name);
    if (existing && existing.size === img.size) {
      counts.skipped++;
      continue;
    }
    onProgress?.(`Backing up image ${i + 1} of ${images.length}…`);
    try {
      if (provider === 'google_drive') {
        await googleUploadFile(accessToken, img.uri, img.name, {
          parents: folderId ? [folderId] : undefined,
          existingId: existing?.id ?? null,
        });
      } else {
        await onedriveUploadFile(accessToken, img.uri, `${IMAGES_FOLDER}/${img.name}`);
      }
      counts.uploaded++;
    } catch {
      counts.failed++;
    }
  }

  // Manifest: a small JSON inventory of the image set, uploaded next to the
  // db. Restore prefers the live folder listing; this is the fallback (and a
  // human-inspectable record of what the backup contains).
  try {
    const manifest: BackupManifest = {
      version: 1,
      created_at: new Date().toISOString(),
      db_filename: BACKUP_FILENAME,
      images: images.map(({ name, size }) => ({ name, size })),
    };
    const tmp = `${FileSystem.cacheDirectory}${MANIFEST_FILENAME}`;
    await FileSystem.writeAsStringAsync(tmp, JSON.stringify(manifest));
    if (provider === 'google_drive') {
      const existing = await googleFindByName(accessToken, MANIFEST_FILENAME);
      await googleUploadFile(accessToken, tmp, MANIFEST_FILENAME, {
        existingId: existing?.id ?? null,
      });
    } else {
      await onedriveUploadFile(accessToken, tmp, MANIFEST_FILENAME);
    }
    await deleteIfExists(tmp);
  } catch {
    // The manifest is an optimization, not a requirement — restore falls back
    // to listing the images folder directly.
  }

  return counts;
}

/** Download + parse the manifest, or null when absent/unreadable. */
async function downloadManifest(
  provider: CloudProvider,
  accessToken: string,
): Promise<BackupManifest | null> {
  const tmp = `${FileSystem.cacheDirectory}${MANIFEST_FILENAME}`;
  try {
    if (provider === 'google_drive') {
      const found = await googleFindByName(accessToken, MANIFEST_FILENAME);
      if (!found) return null;
      await googleDownloadToFile(accessToken, found.id, tmp);
    } else {
      await onedriveDownloadToFile(accessToken, MANIFEST_FILENAME, tmp);
    }
    const text = await FileSystem.readAsStringAsync(tmp);
    return JSON.parse(text) as BackupManifest;
  } catch {
    return null;
  } finally {
    await deleteIfExists(tmp);
  }
}

/**
 * Download the backed-up images into the local `receipts/` dir, skipping files
 * that already exist with a matching size. Per-file failures are counted, not
 * thrown — a missing image must never abort an otherwise-good restore.
 */
async function syncImagesFromCloud(
  provider: CloudProvider,
  accessToken: string,
  onProgress?: BackupProgress,
): Promise<{ downloaded: number; skipped: number; failed: number; total: number }> {
  const counts = { downloaded: 0, skipped: 0, failed: 0, total: 0 };
  await ensureReceiptsDir();

  // Inventory: the live folder listing is the source of truth (Drive needs the
  // file ids anyway); the manifest is the OneDrive fallback when listing fails.
  let remote: RemoteFile[] = [];
  try {
    if (provider === 'google_drive') {
      const folderId = await googleFindFolder(accessToken, IMAGES_FOLDER);
      if (!folderId) return counts; // older backup without images — db only
      remote = await googleListChildren(accessToken, folderId);
    } else {
      remote = await onedriveListChildren(accessToken, IMAGES_FOLDER);
    }
  } catch {
    const manifest = await downloadManifest(provider, accessToken);
    remote = (manifest?.images ?? []).map((m) => ({
      id: null,
      name: m.name,
      size: m.size,
    }));
  }
  counts.total = remote.length;

  const localByName = new Map(
    (await listLocalImages()).map((f) => [f.name, f.size]),
  );

  for (let i = 0; i < remote.length; i++) {
    const file = remote[i];
    if (localByName.get(file.name) === file.size) {
      counts.skipped++;
      continue;
    }
    onProgress?.(`Downloading image ${i + 1} of ${remote.length}…`);
    const dest = `${RECEIPTS_DIR}${file.name}`;
    try {
      if (provider === 'google_drive') {
        if (!file.id) throw new Error('missing Drive file id');
        await googleDownloadToFile(accessToken, file.id, dest);
      } else {
        await onedriveDownloadToFile(
          accessToken,
          `${IMAGES_FOLDER}/${file.name}`,
          dest,
        );
      }
      counts.downloaded++;
    } catch {
      counts.failed++;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Database swap (restore failure-safety)
// ---------------------------------------------------------------------------

/**
 * Swap a downloaded db file into place SAFELY:
 *  1. close the live connection (never overwrite an open database),
 *  2. park the current db as `.bak` and delete the `-wal`/`-shm` sidecars
 *     (stale journals paired with a new main file corrupt or roll it back),
 *  3. move the download in, reopen, and run `PRAGMA integrity_check`,
 *  4. on ANY failure, put the `.bak` back and reopen — the user's existing
 *     data survives a bad/corrupt download. Only a verified db is kept.
 */
async function swapInDownloadedDb(
  downloadedUri: string,
): Promise<{ ok: boolean; message: string }> {
  await resetConnection();

  await deleteIfExists(DB_BAK_PATH);
  let hadOld = false;
  try {
    const info = await FileSystem.getInfoAsync(DB_PATH);
    if (info.exists) {
      await FileSystem.moveAsync({ from: DB_PATH, to: DB_BAK_PATH });
      hadOld = true;
    }
  } catch {
    // No current db (fresh install) — nothing to park.
  }
  await deleteIfExists(DB_WAL_PATH);
  await deleteIfExists(DB_SHM_PATH);

  try {
    await ensureSqliteDir();
    await FileSystem.moveAsync({ from: downloadedUri, to: DB_PATH });
    // Reopen through getDb() so migrations run against the restored file, then
    // verify before declaring success.
    const db = await getDb();
    const row = await db.getFirstAsync<{ integrity_check: string }>(
      'PRAGMA integrity_check;',
    );
    const verdict = row?.integrity_check ?? '';
    if (verdict.toLowerCase() !== 'ok') {
      throw new Error(`integrity_check returned "${verdict || 'nothing'}"`);
    }
  } catch (e) {
    // Roll back: discard the bad download and restore the parked db exactly.
    await resetConnection();
    await deleteIfExists(DB_PATH);
    await deleteIfExists(DB_WAL_PATH);
    await deleteIfExists(DB_SHM_PATH);
    if (hadOld) {
      try {
        await FileSystem.moveAsync({ from: DB_BAK_PATH, to: DB_PATH });
      } catch {
        // Move-back failed; the .bak file still exists on disk as a last resort.
      }
    }
    try {
      await getDb(); // reopen the original so the app keeps working
    } catch {
      // Reopen is retried lazily by the next getDb() caller.
    }
    return {
      ok: false,
      message: errMessage(
        'Downloaded backup failed verification — your existing data was kept',
        e,
      ),
    };
  }

  // Verified — the safety copy is no longer needed.
  await deleteIfExists(DB_BAK_PATH);
  return { ok: true, message: 'verified' };
}

// ---------------------------------------------------------------------------
// Low-level utilities
// ---------------------------------------------------------------------------

/** Ensure the SQLite directory exists before writing a downloaded DB into it. */
async function ensureSqliteDir(): Promise<void> {
  const dir = `${FileSystem.documentDirectory}SQLite`;
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  } catch {
    // Best-effort; downloadAsync will surface a real error if the dir is bad.
  }
}

/**
 * Decode a base64 string to a Uint8Array for binary upload bodies. RN's runtime
 * provides a global `atob`; we guard against environments where it's missing.
 */
function base64ToBytes(b64: string): Uint8Array {
  const decode = (globalThis as { atob?: (s: string) => string }).atob;
  if (typeof decode !== 'function') {
    // Extremely defensive: without atob we cannot binary-encode. Caller's
    // try/catch turns this into a graceful failure message.
    throw new Error('base64 decoding unavailable on this platform');
  }
  const binary = decode(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Read a response body for error messages without throwing. */
async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '<no body>';
  }
}

/** Compose the human image-count summary appended to result messages. */
function imageSummary(counts: {
  uploaded?: number;
  downloaded?: number;
  skipped: number;
  failed: number;
  total: number;
}): string {
  if (counts.total === 0) return '';
  const moved = counts.uploaded ?? counts.downloaded ?? 0;
  const parts = [`${moved + counts.skipped} of ${counts.total} images`];
  if (counts.skipped > 0) parts.push(`${counts.skipped} already up to date`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed — run again to retry`);
  return ` (${parts.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Back up the local SQLite database + receipt images to the user's chosen
 * cloud provider. Checkpoints the WAL first (so the uploaded .db is complete),
 * performs OAuth, uploads the db and any new/changed images, and records
 * `last_backup_at` / `backup_provider` in settings. Never throws — failures
 * are returned. `onProgress` narrates the multi-file phases for the UI.
 */
export async function backupNow(
  provider: CloudProvider,
  onProgress?: BackupProgress,
): Promise<{ ok: boolean; fileId?: string; message: string }> {
  try {
    if (!(await dbFileExists())) {
      return { ok: false, message: 'No local database to back up yet' };
    }

    // Fold the WAL into the main file BEFORE reading it for upload, otherwise
    // every transaction since the last checkpoint is missing from the backup.
    await checkpointWal();

    const auth = await authorize(provider);
    if ('error' in auth) {
      return { ok: false, message: auth.error };
    }

    onProgress?.('Backing up database…');
    const fileId =
      provider === 'google_drive'
        ? await googleUploadFile(auth.accessToken, DB_PATH, BACKUP_FILENAME, {
            existingId: await googleFindBackup(auth.accessToken),
          })
        : await onedriveUploadFile(auth.accessToken, DB_PATH, BACKUP_FILENAME);

    onProgress?.('Backing up receipt images…');
    const counts = await syncImagesToCloud(provider, auth.accessToken, onProgress);

    // Record success in settings (defensive: don't fail the backup if this does).
    try {
      await useSettings.getState().update({
        last_backup_at: new Date().toISOString(),
        backup_provider: provider,
      });
    } catch {
      // Settings store may be unavailable in some contexts; ignore.
    }

    const label = provider === 'google_drive' ? 'Google Drive' : 'OneDrive';
    return {
      ok: true,
      fileId,
      message: `Backed up database to ${label}${imageSummary(counts)}`,
    };
  } catch (e) {
    return { ok: false, message: errMessage('Backup failed', e) };
  }
}

/**
 * Restore the local SQLite database + receipt images from the user's cloud
 * provider. Performs OAuth, downloads the db to a TEMP file, swaps it in via
 * {@link swapInDownloadedDb} (close connection → park `.bak` → clear stale
 * WAL/SHM → verify with integrity_check → roll back on failure), downloads the
 * images, and re-links absolute image uris to this install's sandbox path.
 * The reactive settings store is reloaded from the restored db. Never throws.
 */
export async function restoreFrom(
  provider: CloudProvider,
  onProgress?: BackupProgress,
): Promise<{ ok: boolean; message: string }> {
  try {
    const auth = await authorize(provider);
    if ('error' in auth) {
      return { ok: false, message: auth.error };
    }

    // Download to a temp path first — the live db is untouched until the
    // download is in hand, so a network failure can never corrupt anything.
    onProgress?.('Downloading database…');
    const tmp = `${FileSystem.cacheDirectory}receiptsnap-restore.db`;
    await deleteIfExists(tmp);
    if (provider === 'google_drive') {
      const fileId = await googleFindBackup(auth.accessToken);
      if (!fileId) throw new Error('No backup found in Google Drive');
      await googleDownloadToFile(auth.accessToken, fileId, tmp);
    } else {
      await onedriveDownloadToFile(auth.accessToken, BACKUP_FILENAME, tmp);
    }

    onProgress?.('Verifying database…');
    const swap = await swapInDownloadedDb(tmp);
    await deleteIfExists(tmp);
    if (!swap.ok) {
      return { ok: false, message: swap.message };
    }

    onProgress?.('Downloading receipt images…');
    const counts = await syncImagesFromCloud(provider, auth.accessToken, onProgress);

    // Absolute file:// uris in the restored db point at the OLD install's
    // sandbox; re-key them to this install's receipts dir by filename.
    await relinkImagePaths();

    // Refresh the reactive settings store from the restored database so the
    // app reflects the restored data without requiring a manual restart.
    try {
      await useSettings.getState().load();
    } catch {
      // Non-fatal — settings reload on next app launch regardless.
    }

    const label = provider === 'google_drive' ? 'Google Drive' : 'OneDrive';
    return {
      ok: true,
      message: `Restored database from ${label}${imageSummary(counts)}.`,
    };
  } catch (e) {
    return { ok: false, message: errMessage('Restore failed', e) };
  }
}
