/**
 * Batch image pipeline — processes one or many receipt photos through the full
 * extraction flow with a bounded concurrency so we never flood the device, the
 * network, or the backend's per-device rate limit (50 scans/day).
 *
 * The single-image Quick Scan path also reuses `processImage` so there is ONE
 * canonical pipeline. The key optimization: on-device OCR and base64-encoding
 * run IN PARALLEL (both read the enhanced image), and OCR is time-boxed so a
 * slow/again-failing recognizer can never block the Gemini call — we just send
 * the image with whatever text we have.
 */
import type { ExtractionResult, ImageMeta } from '@/types';
import { autoCropHint, enhanceImage, toBase64 } from './imagePipeline';
import { runOcr } from './ocr';
import { extractReceipt } from './extractClient';
import { listCategories } from '@/db/categories';

/** Hard cap on a single batch so one tap can't fire hundreds of API calls. */
export const MAX_BATCH = 30;
/** Concurrent extract calls; keeps us comfortably under provider rate limits. */
const DEFAULT_CONCURRENCY = 3;
/** Time-box on-device OCR; beyond this we proceed image-only. */
const OCR_TIMEOUT_MS = 1500;

export interface BatchInput {
  uri: string;
  meta?: ImageMeta | null;
}

export interface BatchResult {
  /** The enhanced image actually sent (kept for storage). */
  uri: string;
  /** The original, untouched image (always preserved per spec). */
  originalUri: string;
  meta: ImageMeta | null;
  extraction: ExtractionResult | null;
  error?: string;
}

async function ocrWithTimeout(uri: string): Promise<string> {
  try {
    const result = await Promise.race([
      runOcr(uri).then((r) => r.text),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), OCR_TIMEOUT_MS)),
    ]);
    return result ?? '';
  } catch {
    return '';
  }
}

/**
 * Run the full pipeline for ONE image: enhance (optional), OCR + base64 in
 * parallel, then extract. Returns the enhanced uri + extraction.
 */
export async function processImage(
  uri: string,
  opts: { autoCrop?: boolean; categoryHints?: string[] } = {},
): Promise<{ uri: string; extraction: ExtractionResult }> {
  // auto_crop ON  → detect + tighten to the single receipt, then enhance.
  // auto_crop OFF → keep the original untouched (per the Settings description).
  const enhanced = opts.autoCrop === false ? uri : await autoCropHint(uri);
  // OCR and base64 both consume the enhanced image — run them concurrently so
  // the critical path is max(OCR, encode) instead of OCR + encode.
  const [ocrText, imageBase64] = await Promise.all([
    ocrWithTimeout(enhanced),
    toBase64(enhanced),
  ]);
  const extraction = await extractReceipt({
    imageBase64,
    ocrText,
    imageMimeType: 'image/jpeg',
    categoryHints: opts.categoryHints,
  });
  return { uri: enhanced, extraction };
}

/**
 * Process a STITCHED long receipt captured across several photos into ONE
 * extraction — without paying for several Gemini calls.
 *
 * The previous stitch path extracted only the first page, silently dropping the
 * rest of a long receipt's line items. Here we OCR EVERY page on-device (free)
 * and concatenate the text in capture order, then make a SINGLE `/extract` call
 * with that combined text plus the first (enhanced) page as the representative
 * image. Gemini's extraction is driven mainly by the OCR text, so it now sees
 * the whole receipt while the cost stays at one call.
 *
 * NOTE: we enhance (not auto-crop) the representative page — auto-crop is for
 * isolating a single receipt from its background and would wrongly trim a long
 * receipt. All page images are still persisted by the caller.
 *
 * @param pageUris  Ordered page photos forming the one long receipt (top→bottom).
 * @returns         The representative enhanced uri + the merged extraction.
 */
export async function processStitchedPages(
  pageUris: string[],
  opts: { autoCrop?: boolean; categoryHints?: string[] } = {},
): Promise<{ uri: string; extraction: ExtractionResult }> {
  const pages = pageUris.filter((u): u is string => !!u);
  if (pages.length === 0) {
    const extraction = await extractReceipt({ ocrText: '', categoryHints: opts.categoryHints });
    return { uri: '', extraction };
  }

  // Representative image = first page, enhanced (never auto-cropped — see note).
  const firstEnhanced = opts.autoCrop === false ? pages[0] : await enhanceImage(pages[0]);

  // OCR every page on-device (free) and stitch the text in order.
  const texts = await Promise.all(pages.map((u) => ocrWithTimeout(u)));
  const combinedText = texts.map((t) => t.trim()).filter(Boolean).join('\n');

  const imageBase64 = await toBase64(firstEnhanced);
  const extraction = await extractReceipt({
    imageBase64,
    ocrText: combinedText,
    imageMimeType: 'image/jpeg',
    categoryHints: opts.categoryHints,
  });
  return { uri: firstEnhanced, extraction };
}

/**
 * Process a batch of images with bounded concurrency. Loads the user's category
 * list once and shares it across all items. Reports progress via `onProgress`.
 * Individual failures are captured per-item (never abort the whole batch).
 */
export async function runBatch(
  items: BatchInput[],
  opts: {
    concurrency?: number;
    autoCrop?: boolean;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<BatchResult[]> {
  const capped = items.slice(0, MAX_BATCH);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, 6));

  let categoryHints: string[] | undefined;
  try {
    categoryHints = (await listCategories()).map((c) => c.name);
  } catch {
    categoryHints = undefined;
  }

  const results: BatchResult[] = new Array(capped.length);
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < capped.length) {
      const i = cursor++;
      const item = capped[i];
      try {
        const { uri, extraction } = await processImage(item.uri, {
          autoCrop: opts.autoCrop,
          categoryHints,
        });
        results[i] = { uri, originalUri: item.uri, meta: item.meta ?? null, extraction };
      } catch (e: any) {
        results[i] = {
          uri: item.uri,
          originalUri: item.uri,
          meta: item.meta ?? null,
          extraction: null,
          error: String(e?.message ?? e),
        };
      }
      done++;
      opts.onProgress?.(done, capped.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, capped.length) }, () => worker()),
  );
  return results;
}
