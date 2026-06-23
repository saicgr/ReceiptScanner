/**
 * On-device receipt detection, orientation, and quality — all FREE (no network,
 * no Gemini). This is the engine behind "one photo → many receipts" and the
 * capture-accuracy extras, built entirely on the ML Kit text recognizer the app
 * already ships for OCR.
 *
 * Why on-device: ReceiptSnap is a one-time purchase, so every Gemini call is a
 * recurring cost with no recurring revenue. Detection therefore never touches
 * the network — it reuses the text-block bounding boxes ML Kit returns for free
 * (the same module `src/services/ocr.ts` uses, which discards the geometry) and
 * clusters them into receipts via the pure math in `@/lib/regions`. An optional,
 * user-triggered Gemini "Refine" path lives separately in `detectClient.ts`.
 *
 * Every entry point is defensive: when the native module is unavailable (web,
 * Expo Go, tests) or an image can't be read, we degrade to "couldn't detect"
 * (empty regions / no rotation / quality-ok) so the calling scan flow always
 * proceeds instead of throwing.
 */
import * as ImageManipulator from 'expo-image-manipulator';

import { clusterBlocksIntoRegions, type BlockFrame } from '@/lib/regions';
import { deskewRotation } from '@/lib/deskew';
import type { CropQuality, DetectedRegion } from '@/types';

// ---------------------------------------------------------------------------
// Native ML Kit access (lazy + defensive, mirrors src/services/ocr.ts)
// ---------------------------------------------------------------------------

interface MlKitFrame {
  top?: number | null;
  left?: number | null;
  width?: number | null;
  height?: number | null;
}
interface MlKitBlock {
  text?: string | null;
  frame?: MlKitFrame | null;
}
interface MlKitResult {
  text?: string | null;
  blocks?: MlKitBlock[] | null;
}
interface MlKitTextRecognition {
  recognize: (uri: string) => Promise<MlKitResult>;
}

/** Resolve the native recognizer, or null when it isn't linked (web/Expo Go). */
function loadTextRecognition(): MlKitTextRecognition | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-ml-kit/text-recognition');
    const recognizer = (mod?.default ?? mod) as MlKitTextRecognition | undefined;
    if (recognizer && typeof recognizer.recognize === 'function') return recognizer;
    return null;
  } catch {
    return null;
  }
}

/** Whether on-device detection is even possible on this platform/build. */
export function isDetectionAvailable(): boolean {
  return loadTextRecognition() !== null;
}

/** Recognize text and extract per-block pixel frames. Never throws. */
async function recognizeBlocks(uri: string): Promise<{ text: string; frames: BlockFrame[] }> {
  const TR = loadTextRecognition();
  if (!TR || !uri) return { text: '', frames: [] };
  try {
    const r = await TR.recognize(uri);
    const text = (r?.text ?? '').trim();
    const frames: BlockFrame[] = (r?.blocks ?? [])
      .map((b) => b?.frame)
      .filter(
        (f): f is MlKitFrame =>
          !!f &&
          typeof f.left === 'number' &&
          typeof f.top === 'number' &&
          typeof f.width === 'number' &&
          typeof f.height === 'number',
      )
      .map((f) => ({ left: f.left!, top: f.top!, width: f.width!, height: f.height! }));
    return { text, frames };
  } catch {
    return { text: '', frames: [] };
  }
}

/** Read an image's pixel dimensions via a zero-op manipulation. Null on failure. */
async function probeDimensions(uri: string): Promise<{ width: number; height: number } | null> {
  try {
    const probe = await ImageManipulator.manipulateAsync(uri, [], { base64: false });
    return { width: probe.width, height: probe.height };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect distinct receipts laid out in a SINGLE photo, fully on-device.
 *
 * @returns Normalized regions (one per receipt), ordered top→bottom then
 *          left→right. An EMPTY array means "no distinct regions detected" —
 *          callers should treat the whole image as a single receipt. A length of
 *          1 means one receipt was found (a tight auto-crop); >1 means split.
 */
export async function detectReceiptRegions(uri: string): Promise<DetectedRegion[]> {
  const [{ frames }, dims] = await Promise.all([recognizeBlocks(uri), probeDimensions(uri)]);
  if (!dims || frames.length === 0) return [];
  return clusterBlocksIntoRegions(frames, dims.width, dims.height);
}

/**
 * Estimate the SMALL skew angle (in degrees) a receipt is tilted by, for
 * fine de-skew/straightening. Reuses the free ML Kit text-block frames and the
 * pure `deskewRotation` line-fit math. Returns the corrective rotation
 * (clockwise-positive, matching `expo-image-manipulator`'s `rotate`), or 0 when
 * detection is unavailable / there isn't enough signal to straighten safely.
 *
 * This is the achievable on-device de-skew: a genuine arbitrary-angle correction
 * derived from text geometry. It complements (does not replace) the coarse
 * 0/90/180/270 `detectUprightRotation`. A true perspective de-warp still needs a
 * native vision module the app deliberately doesn't bundle.
 */
export async function detectSkewRotation(uri: string): Promise<number> {
  const { frames } = await recognizeBlocks(uri);
  if (frames.length === 0) return 0;
  return deskewRotation(frames);
}

/** Rotations we consider when auto-straightening a receipt photo. */
const ROTATIONS: readonly (0 | 90 | 180 | 270)[] = [0, 90, 180, 270];

/** Count alphanumeric characters — our proxy for "how upright is this text?". */
function alnumScore(result: MlKitResult | { text?: string | null }): number {
  return ((result?.text ?? '') as string).replace(/[^A-Za-z0-9]/g, '').length;
}

/**
 * Find the rotation (0/90/180/270°) that makes a receipt's text most readable.
 *
 * Upright Latin text yields the most recognized characters, so we OCR the image
 * at each rotation (on a downscaled copy for speed) and keep the best-scoring
 * angle. Returns 0 when detection is unavailable or nothing scores — i.e. "leave
 * it as-is". Fully on-device.
 */
export async function detectUprightRotation(uri: string): Promise<0 | 90 | 180 | 270> {
  const TR = loadTextRecognition();
  if (!TR || !uri) return 0;

  // Probe orientation on a small copy — resolution doesn't change which way is up.
  let probeUri = uri;
  try {
    const small = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 1000 } }], {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    probeUri = small.uri;
  } catch {
    // Keep the original uri if downscale fails.
  }

  let best: { deg: 0 | 90 | 180 | 270; score: number } = { deg: 0, score: -1 };
  for (const deg of ROTATIONS) {
    try {
      const img =
        deg === 0
          ? { uri: probeUri }
          : await ImageManipulator.manipulateAsync(probeUri, [{ rotate: deg }], {
              compress: 0.7,
              format: ImageManipulator.SaveFormat.JPEG,
            });
      const r = await TR.recognize(img.uri);
      const score = alnumScore(r);
      // Strictly-greater keeps the earliest (smallest) angle on ties — prefer 0°.
      if (score > best.score) best = { deg, score };
    } catch {
      // Skip a rotation that fails to render/recognize.
    }
  }
  return best.deg;
}

/**
 * Pure quality heuristic for a cropped receipt — flags crops the user may want
 * to re-shoot. Computed from on-device signals only; no network.
 */
export function assessCropQuality(input: {
  ocrText: string;
  blockCount: number;
  pixelW: number;
  pixelH: number;
}): CropQuality {
  const reasons: string[] = [];
  const alnum = (input.ocrText || '').replace(/[^A-Za-z0-9]/g, '').length;

  if (input.pixelW > 0 && input.pixelH > 0 && (input.pixelW < 200 || input.pixelH < 200)) {
    reasons.push('crop is very small');
  }
  if (alnum < 12) {
    reasons.push('very little text was read — may be blurry or glare');
  } else if (input.blockCount < 2) {
    reasons.push('only one block of text found');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Inspect a single (cropped) image and return a quality verdict. When the native
 * recognizer is unavailable we cannot assess, so we report `ok` to avoid false
 * warnings. Used by the split review grid to badge "check this one" crops.
 */
export async function inspectCrop(uri: string): Promise<CropQuality> {
  if (!isDetectionAvailable()) return { ok: true, reasons: [] };
  const [{ text, frames }, dims] = await Promise.all([recognizeBlocks(uri), probeDimensions(uri)]);
  return assessCropQuality({
    ocrText: text,
    blockCount: frames.length,
    pixelW: dims?.width ?? 0,
    pixelH: dims?.height ?? 0,
  });
}
