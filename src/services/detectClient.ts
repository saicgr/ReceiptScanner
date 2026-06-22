/**
 * Optional Gemini-backed multi-receipt detection ("Refine with AI").
 *
 * IMPORTANT — cost model: ReceiptSnap is a one-time purchase, so this network
 * path is NEVER on the default flow. Multi-receipt splitting runs ON-DEVICE for
 * free (`src/services/receiptDetect.ts`); this client is only invoked when the
 * user explicitly taps "Refine with AI" because the on-device split looked
 * wrong. The call is rate-limited server-side (it consumes one scan unit) and
 * gated behind the paywall by the caller, so it can never run away with cost.
 *
 * Contract: POST `/detect-receipts` with `{ imageBase64, imageMimeType }` and the
 * `X-Device-Id`/`X-Device-Token` auth headers (via `authedFetch`). The server
 * returns `{ count, regions:[{x,y,width,height,
 * label}] }` with normalized 0..1 boxes. On ANY failure we return `[]` so the
 * caller simply keeps its on-device result — refine is best-effort.
 */
import * as FileSystem from 'expo-file-system/legacy';

import { appConfig } from '@/lib/config';
import { authedFetch } from '@/services/extractClient';
import type { DetectedRegion } from '@/types';

/** Abort the refine call after this long; we'd rather keep the on-device split. */
const REQUEST_TIMEOUT_MS = 35000;

/** Coerce/clamp a server payload into strict normalized DetectedRegions. */
function normalizeRegions(raw: unknown): DetectedRegion[] {
  if (!Array.isArray(raw)) return [];
  const out: DetectedRegion[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    const x = Number(o.x);
    const y = Number(o.y);
    const width = Number(o.width);
    const height = Number(o.height);
    if (![x, y, width, height].every(Number.isFinite)) continue;
    const cx = Math.min(Math.max(x, 0), 1);
    const cy = Math.min(Math.max(y, 0), 1);
    const cw = Math.min(Math.max(width, 0), 1 - cx);
    const ch = Math.min(Math.max(height, 0), 1 - cy);
    if (cw < 0.03 || ch < 0.03) continue;
    out.push({
      x: cx,
      y: cy,
      width: cw,
      height: ch,
      label: typeof o.label === 'string' ? o.label : null,
    });
  }
  return out;
}

/**
 * Ask the backend (Gemini) to detect receipt regions in a photo. Best-effort:
 * returns `[]` on offline / rate-limit / error so the caller keeps its on-device
 * detection. Reads the image to base64 if only a uri is provided.
 */
export async function detectReceiptRegionsAI(args: {
  imageBase64?: string | null;
  imageUri?: string;
  imageMimeType?: string;
}): Promise<DetectedRegion[]> {
  let imageBase64 = args.imageBase64 ?? null;
  if (!imageBase64 && args.imageUri) {
    try {
      imageBase64 = await FileSystem.readAsStringAsync(args.imageUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } catch {
      imageBase64 = null;
    }
  }
  if (!imageBase64) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await authedFetch(`${appConfig.apiBaseUrl}/detect-receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, imageMimeType: args.imageMimeType ?? 'image/jpeg' }),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (__DEV__) console.warn(`[detectClient] HTTP ${res.status}; keeping on-device split`);
      return [];
    }
    const json = (await res.json()) as { regions?: unknown };
    return normalizeRegions(json?.regions);
  } catch (err) {
    if (__DEV__) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[detectClient] ${reason}; keeping on-device split`);
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}
