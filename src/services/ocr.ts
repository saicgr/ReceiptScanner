/**
 * On-device OCR.
 *
 * We run text recognition locally (Google ML Kit via
 * `@react-native-ml-kit/text-recognition`) BEFORE hitting the network. The
 * recognized text is then sent alongside the image to the `/extract` backend
 * proxy so Gemini gets a head start and our local fallback heuristic has
 * something to work with even when the device is offline.
 *
 * ML Kit is a native module, so it is unavailable on web and in some test
 * environments. Every code path here is defensive: any failure (missing native
 * module, unreadable image, recognition error) degrades gracefully to an empty
 * result `{ text: '', blocks: [] }` instead of throwing, so the calling scan
 * flow can still proceed straight to the network extractor.
 */
import type { OcrResult } from '@/types';

/**
 * Minimal structural shape of the ML Kit result we depend on. The library types
 * are richer than this, but pinning only what we read keeps us resilient to
 * version drift and lets us import the module lazily.
 */
interface MlKitBlock {
  text?: string | null;
  // ML Kit does not expose a numeric block-level confidence on every platform,
  // so we treat it as optional and omit it from our blocks when absent.
  confidence?: number | null;
}
interface MlKitResult {
  text?: string | null;
  blocks?: MlKitBlock[] | null;
}
interface MlKitTextRecognition {
  recognize: (uri: string) => Promise<MlKitResult>;
}

/** An OcrResult representing "no text recognized / OCR unavailable". */
const EMPTY_RESULT: OcrResult = { text: '', blocks: [] };

/**
 * Lazily resolve the native TextRecognition module.
 *
 * We `require` it inside a try/catch rather than importing at the top level so
 * that on web (or anywhere the native module is absent) merely loading this
 * file never throws — `runOcr` simply returns the empty result instead.
 */
function loadTextRecognition(): MlKitTextRecognition | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-ml-kit/text-recognition');
    // The package ships the recognizer as a default export.
    const recognizer = (mod?.default ?? mod) as MlKitTextRecognition | undefined;
    if (recognizer && typeof recognizer.recognize === 'function') {
      return recognizer;
    }
    return null;
  } catch {
    // Native module not linked (e.g. web, Expo Go without the module, tests).
    return null;
  }
}

/**
 * Run on-device OCR over a local image uri.
 *
 * @param imageUri  A `file://` (or otherwise locally readable) image uri.
 * @returns         The recognized full text plus per-block text. Never rejects;
 *                  returns `{ text: '', blocks: [] }` when OCR is unavailable or
 *                  the image cannot be processed.
 */
export async function runOcr(imageUri: string): Promise<OcrResult> {
  if (!imageUri) return EMPTY_RESULT;

  const TextRecognition = loadTextRecognition();
  if (!TextRecognition) return EMPTY_RESULT;

  try {
    const result = await TextRecognition.recognize(imageUri);

    const text = (result?.text ?? '').trim();

    const blocks: OcrResult['blocks'] = (result?.blocks ?? [])
      // Guard against null/undefined entries from the native bridge.
      .filter((b): b is MlKitBlock => !!b && typeof b.text === 'string')
      .map((b) => {
        const blockText = (b.text ?? '').trim();
        // Only attach `confidence` when the platform actually provided a finite
        // number, so consumers can rely on its presence meaning "real value".
        return typeof b.confidence === 'number' && Number.isFinite(b.confidence)
          ? { text: blockText, confidence: b.confidence }
          : { text: blockText };
      })
      .filter((b) => b.text.length > 0);

    return { text, blocks };
  } catch {
    // Recognition failed (unreadable image, decode error, native crash guard).
    // Degrade gracefully so the scan flow can fall through to /extract.
    return EMPTY_RESULT;
  }
}
