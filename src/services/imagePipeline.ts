/**
 * Image pipeline — capture / import, crop & enhance, PDF intake, and stitching.
 *
 * This service is the single funnel through which every receipt image enters the
 * app. Responsibilities:
 *   - Importing images from the gallery (`pickFromGallery`).
 *   - On-device enhancement: downscale to a sane max dimension and apply a light
 *     contrast/quality pass so OCR + the /extract proxy get a clean image
 *     (`enhanceImage`).
 *   - A document auto-crop *hint* (`autoCropHint`). True quadrilateral edge
 *     detection needs a native vision module we don't ship, so this honestly
 *     degrades to the enhance pass — see the comment on the function.
 *   - PDF import (`importPdf`). Rasterising PDF pages to images requires a native
 *     PDF renderer that Expo Go does not provide; we keep the multi-page
 *     contract (`pageUris`) but, when rasterisation isn't feasible, return the
 *     PDF uri itself as the single "page" so the rest of the flow still works.
 *   - Stitching several photos of ONE long receipt into a single tall image
 *     (`stitchImages`). A pixel-perfect vertical concatenation needs a native
 *     canvas; we normalise widths with `expo-image-manipulator` and document the
 *     fallback behaviour honestly.
 *   - Persisting the chosen image under the user's filename template
 *     (`saveImageWithName`) into a dedicated `receipts/` directory
 *     (`RECEIPTS_DIR`).
 *
 * Every native module is loaded normally (this file is only ever imported from
 * native screens), but every async entry point is defensive: failures degrade to
 * a usable result (usually the original uri) instead of throwing, so a scan can
 * always proceed to OCR/extraction.
 */
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { regionToPixelRect } from '@/lib/regions';
import type { DetectedRegion, ImageMeta } from '@/types';
import {
  detectReceiptRegions,
  detectSkewRotation,
  detectUprightRotation,
} from './receiptDetect';

/**
 * Directory under the app's sandboxed document storage where finalized receipt
 * images live. `saveImageWithName` writes here; the DB stores the resulting
 * `file://` uris. Kept as a stable absolute path so other services (filename
 * batch-rename, backup) can reason about it.
 */
export const RECEIPTS_DIR = `${FileSystem.documentDirectory}receipts/`;

/** Longest edge (in px) we keep after enhancement. Keeps OCR fast and uploads
 *  cheap while staying well above the resolution needed to read receipt text. */
const MAX_DIMENSION = 2000;

/** JPEG quality for enhanced/normalised images (0..1). High enough to preserve
 *  small printed digits, low enough to keep the base64 payload to /extract lean. */
const ENHANCE_QUALITY = 0.8;

/**
 * Ensure `RECEIPTS_DIR` exists before we write into it.
 *
 * `makeDirectoryAsync({ intermediates: true })` is idempotent, but we still
 * guard with an existence check + try/catch so a transient FS error never
 * bubbles up to the scan flow.
 */
async function ensureReceiptsDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(RECEIPTS_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(RECEIPTS_DIR, { intermediates: true });
    }
  } catch {
    // Best-effort: if the directory already exists or creation races with
    // another call, the subsequent copy will surface a real error instead.
  }
}

/**
 * Pick one or more images from the device photo library.
 *
 * @param opts.multiple  When true, allow multi-selection (used by Multi-Scan).
 * @returns              An array of local image uris (empty if the user cancels
 *                       or the picker is unavailable). Never rejects.
 */
export async function pickFromGallery(opts?: { multiple?: boolean }): Promise<string[]> {
  const allowsMultiple = opts?.multiple ?? false;
  try {
    // Permission is requested lazily; on web the picker resolves without a
    // native permission prompt.
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== 'granted' && !perm.canAskAgain && !allowsMultiple) {
      // Permission permanently denied — nothing to return. The caller shows UI.
      return [];
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: allowsMultiple,
      // Keep the original image; we run our own enhance/crop pass afterwards so
      // the user's edits don't double up with ours.
      quality: 1,
      exif: false,
    });

    if (result.canceled) return [];
    return result.assets.map((a) => a.uri).filter((u): u is string => !!u);
  } catch {
    // Picker unavailable (web/test) or user environment error.
    return [];
  }
}

/** Read a local file uri to a base64 string (used to encode in parallel with OCR). */
export async function toBase64(uri: string): Promise<string> {
  try {
    return await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch {
    return '';
  }
}

/**
 * Import one or more receipt photos from the library AND read each photo's EXIF
 * metadata (capture time + GPS) — useful as a fallback date and to record where
 * a receipt was photographed. Used by the import / batch flows.
 */
export async function pickReceiptsWithMeta(
  opts?: { multiple?: boolean },
): Promise<{ uri: string; meta: ImageMeta }[]> {
  const allowsMultiple = opts?.multiple ?? false;
  try {
    await ImagePicker.requestMediaLibraryPermissionsAsync();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: allowsMultiple,
      quality: 1,
      exif: true, // we want capture time + GPS
    });
    if (result.canceled) return [];
    return result.assets
      .filter((a) => !!a.uri)
      .map((a) => ({ uri: a.uri, meta: parseAssetMeta(a) }));
  } catch {
    return [];
  }
}

/**
 * Parse an ImagePicker asset's EXIF into our ImageMeta. EXIF key names vary by
 * platform (iOS nests under `{Exif}`/`{GPS}`; Android is flat), so we probe
 * several shapes and degrade to nulls. Never throws.
 */
export function parseAssetMeta(asset: {
  uri: string;
  width?: number;
  height?: number;
  exif?: Record<string, any> | null;
}): ImageMeta {
  const exif = asset.exif ?? {};
  const gps = exif['{GPS}'] ?? exif;
  const exifBlock = exif['{Exif}'] ?? exif;

  return {
    uri: asset.uri,
    capturedAt: parseExifDate(
      exifBlock.DateTimeOriginal ?? exif.DateTimeOriginal ?? exif.DateTime,
    ),
    lat: parseGps(gps.Latitude ?? exif.GPSLatitude, gps.LatitudeRef ?? exif.GPSLatitudeRef),
    lng: parseGps(gps.Longitude ?? exif.GPSLongitude, gps.LongitudeRef ?? exif.GPSLongitudeRef),
    width: typeof asset.width === 'number' ? asset.width : null,
    height: typeof asset.height === 'number' ? asset.height : null,
  };
}

/** EXIF dates look like "2026:03:02 17:40:11"; convert to an ISO datetime. */
function parseExifDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** Convert an EXIF GPS value (+ hemisphere ref) to a signed decimal degree. */
function parseGps(value: unknown, ref: unknown): number | null {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) return null;
  const r = typeof ref === 'string' ? ref.toUpperCase() : '';
  const signed = r === 'S' || r === 'W' ? -Math.abs(n) : n;
  return signed;
}

/**
 * Enhance an image for OCR + extraction: resize so the longest edge is at most
 * {@link MAX_DIMENSION}px and re-encode at {@link ENHANCE_QUALITY}.
 *
 * `expo-image-manipulator` does not expose a contrast/brightness operation, so
 * "modest contrast" here is achieved by the high-quality re-encode + downscale,
 * which already sharpens printed text noticeably for ML Kit. (A true contrast
 * curve would require a native image-processing module we don't ship.) We always
 * resize on the *longer* edge so portrait receipts aren't squashed.
 *
 * @param uri  Local image uri.
 * @returns    The uri of the processed image, or the original uri if the
 *             manipulator is unavailable / fails.
 */
export async function enhanceImage(uri: string): Promise<string> {
  if (!uri) return uri;
  try {
    // We can't know the source dimensions cheaply without a first decode, so we
    // ask the manipulator to fit within MAX_DIMENSION on whichever edge is
    // longer. Passing only `width` would force-scale portrait images; instead we
    // resize by the dominant edge using the manipulator's aspect-preserving
    // behaviour (supplying a single dimension keeps the aspect ratio).
    //
    // To pick the right edge we do a zero-op manipulation first to read size.
    const probe = await ImageManipulator.manipulateAsync(uri, [], {
      base64: false,
    });
    const { width, height } = probe;

    const actions: ImageManipulator.Action[] = [];
    if (width >= height && width > MAX_DIMENSION) {
      actions.push({ resize: { width: MAX_DIMENSION } });
    } else if (height > width && height > MAX_DIMENSION) {
      actions.push({ resize: { height: MAX_DIMENSION } });
    }

    const out = await ImageManipulator.manipulateAsync(probe.uri, actions, {
      compress: ENHANCE_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return out.uri;
  } catch {
    // Manipulator unavailable (web/test) or decode failure — fall back to the
    // original so the scan can still proceed.
    return uri;
  }
}

/**
 * Fine de-skew / straighten a receipt by an arbitrary small angle, on-device.
 *
 * Estimates the tilt from the receipt's OCR text-block geometry (see
 * `detectSkewRotation`) and applies the corrective rotation with
 * `expo-image-manipulator`'s arbitrary-angle `rotate`. This is a GENUINE
 * sub-degree-to-~15° correction — not the coarse 0/90/180/270 step — so slightly
 * crooked photos come out straight before OCR/extraction.
 *
 * Honest limitation: this corrects in-plane ROTATION only. A full perspective
 * de-warp (correcting a receipt photographed at an angle so it looks scanned
 * flat) needs a native quadrilateral/vision module the app deliberately doesn't
 * bundle, so it remains out of scope. When detection is unavailable or the tilt
 * is below threshold, the image is returned unchanged.
 *
 * @param uri  Local image uri.
 * @returns    The straightened image uri, or the original on no-op/failure.
 */
export async function deskewImage(uri: string): Promise<string> {
  if (!uri) return uri;
  try {
    const deg = await detectSkewRotation(uri);
    if (!deg) return uri; // nothing worth correcting (or detection unavailable)
    const out = await ImageManipulator.manipulateAsync(uri, [{ rotate: deg }], {
      compress: ENHANCE_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return out.uri;
  } catch {
    // Manipulator unavailable (web/test) or rotate failure — keep the source.
    return uri;
  }
}

/**
 * Crop a single normalized region out of an image (and optionally rotate it).
 *
 * The region's `x/y/width/height` are 0..1 fractions of the source image, so we
 * first read the pixel dimensions, convert to an integer crop rect via
 * `regionToPixelRect` (which clamps to bounds), then apply `crop` followed by an
 * optional `rotate` in a single manipulation. Re-encodes at {@link ENHANCE_QUALITY}.
 *
 * @returns The cropped image uri, or the original uri on any failure.
 */
export async function cropNormalizedRegion(
  uri: string,
  region: DetectedRegion,
  opts: { padding?: number; rotateDeg?: 0 | 90 | 180 | 270 } = {},
): Promise<string> {
  if (!uri) return uri;
  try {
    const probe = await ImageManipulator.manipulateAsync(uri, [], { base64: false });
    const rect = regionToPixelRect(region, probe.width, probe.height, opts.padding ?? 0);
    const actions: ImageManipulator.Action[] = [
      {
        crop: {
          originX: rect.originX,
          originY: rect.originY,
          width: rect.width,
          height: rect.height,
        },
      },
    ];
    // Crop happens in the source's orientation first; rotate afterwards.
    // (A 0° rotate is falsy, so this also skips the no-op case.)
    if (opts.rotateDeg) actions.push({ rotate: opts.rotateDeg });
    const out = await ImageManipulator.manipulateAsync(probe.uri, actions, {
      compress: ENHANCE_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return out.uri;
  } catch {
    // Manipulator unavailable (web/test) or out-of-bounds rect — return source.
    return uri;
  }
}

/**
 * Split ONE photo containing several receipts into one image per receipt.
 *
 * Crops each detected region (with a little padding so edges aren't shaved) and,
 * when `autoRotate` is set, straightens each crop upright via on-device
 * orientation detection. Runs sequentially to keep peak memory bounded — the
 * region count is small (one batch of receipts).
 *
 * @param regions  Normalized regions from `detectReceiptRegions`.
 * @returns        One cropped (optionally rotated) image uri per region; empty
 *                 when there is nothing to split.
 */
export async function splitImageIntoReceipts(
  uri: string,
  regions: DetectedRegion[],
  opts: { autoRotate?: boolean; padding?: number } = {},
): Promise<string[]> {
  if (!uri || regions.length === 0) return [];
  const padding = opts.padding ?? 0.01;
  const out: string[] = [];
  for (const region of regions) {
    let cropped = await cropNormalizedRegion(uri, region, { padding });
    if (opts.autoRotate) {
      const deg = await detectUprightRotation(cropped);
      if (deg !== 0) {
        try {
          const rotated = await ImageManipulator.manipulateAsync(cropped, [{ rotate: deg }], {
            compress: ENHANCE_QUALITY,
            format: ImageManipulator.SaveFormat.JPEG,
          });
          cropped = rotated.uri;
        } catch {
          // Keep the un-rotated crop if rotation fails.
        }
      }
    }
    out.push(cropped);
  }
  return out;
}

/**
 * Auto-crop + straighten a SINGLE receipt out of its background, on-device.
 *
 * Pipeline (all on-device, all free — reuses the ML Kit OCR we already run):
 *   1. De-skew: estimate the small tilt from text-block geometry and rotate the
 *      photo straight (`deskewImage`) BEFORE detecting regions, so the crop is
 *      tight to an upright receipt.
 *   2. Auto-crop: detect receipt regions and, when EXACTLY ONE is found, tighten
 *      to that region (a genuine crop). When detection finds nothing we keep the
 *      whole image; when it finds MORE than one receipt we keep the whole image
 *      and leave splitting to the dedicated multi-receipt flow (so we never
 *      silently drop one of several receipts).
 *   3. Enhance: downscale + high-quality re-encode for OCR/extraction.
 *
 * Honest limitations:
 *   - De-skew corrects in-plane ROTATION only; a true perspective de-warp needs a
 *     native vision module the app deliberately doesn't bundle.
 *   - The crop is axis-aligned to the text bounds, not a quadrilateral de-warp.
 *   - Pixel-level contrast / brightness / denoise / grayscale-threshold passes
 *     (which would help faded thermal receipts most) are NOT applied:
 *     `expo-image-manipulator` exposes only geometric ops (resize/rotate/flip/
 *     crop/extent), no per-pixel filters, so those remain out of scope without a
 *     native image-processing module. The high-quality re-encode is the only
 *     "contrast" we can honestly claim.
 *
 * @param uri   Local image uri.
 * @param opts  `deskew` (default true) toggles the fine straighten step so the
 *              user can disable it independently of crop/enhance in Settings.
 * @returns     The straightened-cropped-and-enhanced uri. Never rejects.
 */
export async function autoCropHint(
  uri: string,
  opts: { deskew?: boolean } = {},
): Promise<string> {
  let working = uri;
  try {
    // Straighten first so the subsequent region crop is tight to the upright text.
    if (opts.deskew !== false) working = await deskewImage(uri);
    const regions = await detectReceiptRegions(working);
    if (regions.length === 1) {
      const cropped = await cropNormalizedRegion(working, regions[0], { padding: 0.02 });
      return enhanceImage(cropped);
    }
  } catch {
    // Detection/deskew unavailable or failed — fall through to a plain enhance.
  }
  return enhanceImage(working);
}

/**
 * Count the pages in a PDF by scanning its raw bytes for page objects — a pure,
 * dependency-free parse that needs NO renderer. We count `/Type /Page` markers
 * (tolerating arbitrary whitespace) but exclude `/Type /Pages` (the page-tree
 * node). This is heuristic: it can miss pages in object-stream-compressed
 * (PDF 1.5+) files, so it's a best-effort lower bound, defaulting to 1.
 *
 * Exported for unit testing.
 */
export function countPdfPages(pdfText: string): number {
  if (!pdfText) return 1;
  // Match "/Type /Page" but not "/Type /Pages". The negative lookahead after
  // "Page" rejects the trailing "s" of the page-tree node.
  const matches = pdfText.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  const n = matches ? matches.length : 0;
  return n > 0 ? n : 1;
}

/**
 * Rasterise a PDF's pages to images for on-device OCR.
 *
 * HONEST STATUS — PARTIAL (no true on-device rasterisation). Rendering PDF page
 * content to a bitmap requires a native PDF renderer (pdfium / PDFKit) or a
 * WebView+pdf.js bridge; none ship in this managed Expo app (no
 * react-native-webview, no expo-gl, no native pdf module), and adding one means
 * a heavy native dependency + custom config plugin + dev-build change that is
 * out of scope here. `expo-image-manipulator` cannot decode PDF input either.
 *
 * What this DOES do honestly:
 *   - Determines the real page count from the PDF bytes (`countPdfPages`).
 *   - Returns the PDF uri itself as the single rasterised "page" with
 *     `rasterized:false`, so callers know on-device OCR will be empty and that
 *     extraction must rely on the backend (Gemini reads every PDF page
 *     server-side). The original PDF is still stored and viewable.
 *
 * When a native rasteriser is later added, this is the ONE place to expand
 * `pageImageUris` to one real image per page; the return shape already fits.
 *
 * @returns `{ uri, pageImageUris, pageCount, rasterized }`.
 */
export async function rasterizePdf(
  uri: string,
): Promise<{ uri: string; pageImageUris: string[]; pageCount: number; rasterized: boolean }> {
  let pageCount = 1;
  try {
    // Read enough of the PDF to count pages. PDFs are latin1/binary; reading as
    // UTF-8 still preserves the ASCII "/Type /Page" markers we look for.
    const text = await FileSystem.readAsStringAsync(uri).catch(() => '');
    pageCount = countPdfPages(text);
  } catch {
    pageCount = 1;
  }
  // No on-device renderer available — the PDF itself is the single logical page.
  return { uri, pageImageUris: [uri], pageCount, rasterized: false };
}

/**
 * Import a PDF (e.g. an emailed e-receipt or a scanned multi-page document).
 *
 * Honest limitation: rasterising PDF pages to images needs a native PDF
 * renderer (e.g. PDFKit / pdfium), which Expo Go and our managed workflow don't
 * provide — see `rasterizePdf` for the full status. We therefore keep the
 * multi-page contract but return the PDF uri itself as a single logical "page",
 * now annotated with the REAL page count parsed from the bytes. Downstream:
 *   - OCR (`runOcr`) treats it as an unreadable image and returns empty text,
 *     so extraction relies on the backend, which CAN parse PDFs server-side.
 *   - The original PDF is still stored and viewable/shareable.
 * When a native rasteriser is added, expand `pageUris` to one image per page;
 * the `{ uri, pageUris, pageCount }` shape already accommodates that.
 *
 * @returns  `{ uri, pageUris, pageCount, rasterized }` for the picked PDF, or
 *           `null` if the user cancels / the picker is unavailable.
 */
export async function importPdf(): Promise<{
  uri: string;
  pageUris: string[];
  pageCount: number;
  rasterized: boolean;
} | null> {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'application/pdf',
      copyToCacheDirectory: true,
      multiple: false,
    });

    if (result.canceled) return null;
    const asset = result.assets?.[0];
    if (!asset?.uri) return null;

    // Attempt rasterisation (currently page-count only — see rasterizePdf).
    const { pageImageUris, pageCount, rasterized } = await rasterizePdf(asset.uri);
    return { uri: asset.uri, pageUris: pageImageUris, pageCount, rasterized };
  } catch {
    // DocumentPicker unavailable (web/test) or user-environment error.
    return null;
  }
}

/**
 * Stitch several photos of ONE long receipt into a single tall image.
 *
 * Best-effort, on-device approach:
 *   - With 0 inputs we return an empty string (nothing to stitch).
 *   - With 1 input we just enhance and return it.
 *   - With N inputs we normalise every photo to a common width (the minimum
 *     width across the set, so nothing is upscaled) and enhance each one.
 *
 * Honest limitation — why we do NOT produce one tall composite file:
 * `expo-image-manipulator` has no "compose/append" operation, so pixels cannot
 * be merged into one bitmap purely in JS. The alternative (rendering the pages
 * in an offscreen stacked view and capturing it with react-native-view-shot)
 * was considered and deliberately rejected: long receipts easily exceed GPU
 * texture limits (~4–8k px) forcing lossy downscales, the capture depends on
 * every page Image having finished async-loading offscreen, and it would add a
 * native dependency exercised only here. Instead, stitched receipts are
 * first-class MULTI-PAGE receipts: every page is persisted durably alongside
 * the receipt (see `persistReceiptImages`) and the full-screen viewer pages
 * through all of them, so the user genuinely sees the whole long receipt.
 * Extraction still treats the stitch as ONE receipt — `processStitchedPages`
 * OCRs every page and makes a single /extract call.
 *
 * This function therefore returns the FIRST normalised page's uri as the
 * representative image, while the caller (Multi-Scan) keeps ALL page uris and
 * persists them via the receipt's image list, preserving the full long receipt
 * across pages. The width-normalisation here means that if a native stitcher is
 * added later, the pages are already alignment-ready.
 *
 * @param uris  Ordered list of photos forming the long receipt (top → bottom).
 * @returns     The representative (first, normalised) page uri, or '' when given
 *              no inputs.
 */
export async function stitchImages(uris: string[]): Promise<string> {
  const inputs = uris.filter((u): u is string => !!u);
  if (inputs.length === 0) return '';
  if (inputs.length === 1) return enhanceImage(inputs[0]);

  try {
    // Probe every page to find a common target width (the smallest width so we
    // only ever downscale, never invent pixels).
    const sizes = await Promise.all(
      inputs.map(async (u) => {
        try {
          const probe = await ImageManipulator.manipulateAsync(u, [], { base64: false });
          return { uri: probe.uri, width: probe.width, height: probe.height };
        } catch {
          return { uri: u, width: 0, height: 0 };
        }
      })
    );

    const widths = sizes.map((s) => s.width).filter((w) => w > 0);
    const targetWidth = widths.length > 0 ? Math.min(...widths, MAX_DIMENSION) : MAX_DIMENSION;

    // Normalise each page to the common width + enhance. We run these
    // sequentially-ish via Promise.all; failures fall back to the source uri.
    const normalised = await Promise.all(
      sizes.map(async (s) => {
        try {
          const out = await ImageManipulator.manipulateAsync(
            s.uri,
            s.width > targetWidth ? [{ resize: { width: targetWidth } }] : [],
            { compress: ENHANCE_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
          );
          return out.uri;
        } catch {
          return s.uri;
        }
      })
    );

    // Representative page = the first normalised image. See the limitation note
    // above: the remaining pages are retained by the caller as page images.
    return normalised[0] ?? inputs[0];
  } catch {
    // Manipulator unavailable — return the first input unchanged so the long
    // receipt at least yields a usable primary image.
    return inputs[0];
  }
}

/** Lowercased extension (no dot) of a filename or uri; '' when there is none. */
function extensionOf(name: string): string {
  const clean = name.split('?')[0] ?? name;
  const m = clean.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

/** Image extensions `expo-image-manipulator` can decode for a transcode pass. */
const TRANSCODABLE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

/**
 * Re-encode `uri` so its bytes match the requested target extension — this is
 * the FINAL encode step that makes the Settings "PNG" choice real instead of
 * cosmetic (the OCR/extract pipeline stays JPEG for payload size; only the
 * file the user keeps is format-converted). No-op when the bytes already match,
 * when the target isn't jpg/png, or when the source isn't a decodable image
 * (e.g. an imported PDF stored verbatim).
 *
 * @returns A cache uri in the target format, or `uri` unchanged on no-op/failure.
 */
async function encodeForExtension(uri: string, targetExt: string): Promise<string> {
  const norm = (e: string) => (e === 'jpeg' ? 'jpg' : e);
  const want = norm(targetExt);
  if (want !== 'jpg' && want !== 'png') return uri;
  const srcExt = extensionOf(uri);
  if (norm(srcExt) === want) return uri; // bytes already match the name
  if (!TRANSCODABLE_EXTS.includes(srcExt)) return uri; // PDF etc. — copy verbatim
  try {
    const out = await ImageManipulator.manipulateAsync(uri, [], {
      // PNG is lossless; `compress` only applies to JPEG.
      compress: want === 'png' ? 1 : ENHANCE_QUALITY,
      format:
        want === 'png' ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG,
    });
    return out.uri;
  } catch {
    // Manipulator unavailable (web/test) — keep the original bytes rather than
    // failing the save.
    return uri;
  }
}

/**
 * Find a destination uri in {@link RECEIPTS_DIR} that does not collide with an
 * existing file. The filename template is NOT guaranteed unique — two same-day,
 * same-vendor, same-amount receipts render identically — so on collision we
 * append a numeric suffix before the extension: `name.jpg` → `name_2.jpg` →
 * `name_3.jpg`… instead of silently destroying the earlier receipt's image.
 *
 * When a candidate slot is occupied by `srcUri` ITSELF (re-saving a receipt
 * whose file already carries a suffix), that uri is returned so the caller can
 * skip the copy instead of cycling suffixes on every save.
 */
async function nextAvailableUri(safeName: string, srcUri: string): Promise<string> {
  const dot = safeName.lastIndexOf('.');
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
  const ext = dot > 0 ? safeName.slice(dot) : '';
  let candidate = `${RECEIPTS_DIR}${safeName}`;
  for (let n = 2; n <= 1000; n++) {
    if (candidate === srcUri) return srcUri; // already saved under this family
    const info = await FileSystem.getInfoAsync(candidate);
    if (!info.exists) return candidate;
    candidate = `${RECEIPTS_DIR}${stem}_${n}${ext}`;
  }
  // Pathological collision storm — fall back to a timestamp suffix.
  return `${RECEIPTS_DIR}${stem}_${Date.now()}${ext}`;
}

/**
 * Copy an image into {@link RECEIPTS_DIR} under a specific filename.
 *
 * Used after the review screen computes the user's filename-template name. We
 * copy (not move) so the source cache file is left intact for the caller. The
 * source is first transcoded so its bytes match the filename's extension (the
 * user's jpg/png choice). If a file with the same name already exists we do
 * NOT overwrite it — a numeric suffix is appended (`_2`, `_3`, …) and the
 * ACTUAL saved uri is returned, so the caller must store the returned name.
 *
 * @param srcUri    The processed image to persist.
 * @param filename  Desired filename INCLUDING extension (e.g. `2026-06-04_Acme_42.10.jpg`).
 * @returns         The new `file://` uri inside `RECEIPTS_DIR` (possibly with a
 *                  collision suffix). On copy failure, returns the original
 *                  `srcUri` so the receipt still references a real image.
 */
export async function saveImageWithName(srcUri: string, filename: string): Promise<string> {
  if (!srcUri) return srcUri;
  await ensureReceiptsDir();

  const safeName = sanitizeFilename(filename);
  // Re-saving a file under its own current name (e.g. editing a receipt whose
  // filename didn't change) is a no-op — and must not mint a `_2` suffix.
  if (srcUri === `${RECEIPTS_DIR}${safeName}`) return srcUri;

  // Final encode: make the bytes match the user's chosen format/extension.
  const prepared = await encodeForExtension(srcUri, extensionOf(safeName));

  try {
    const destUri = await nextAvailableUri(safeName, srcUri);
    if (destUri === srcUri) return srcUri; // already saved — nothing to copy
    await FileSystem.copyAsync({ from: prepared, to: destUri });
    return destUri;
  } catch {
    // Copy failed (e.g. unreadable source, FS error). Keep referencing the
    // original so we never end up with a receipt pointing at a missing file.
    return srcUri;
  } finally {
    // The transcode output is a throwaway cache file — drop it once copied.
    if (prepared !== srcUri) {
      await FileSystem.deleteAsync(prepared, { idempotent: true }).catch(() => {});
    }
  }
}

/** Is this uri an app-managed temp/managed file we are allowed to delete?
 *  (Camera/manipulator/picker outputs land in the cache dir; superseded saved
 *  images live in RECEIPTS_DIR. User gallery originals are NEVER under either.) */
function isDeletableSource(uri: string): boolean {
  const cache = FileSystem.cacheDirectory;
  return (!!cache && uri.startsWith(cache)) || uri.startsWith(RECEIPTS_DIR);
}

/**
 * Durably persist a receipt's ENTIRE image family into {@link RECEIPTS_DIR}.
 *
 * Camera output, ImageManipulator results and picker copies all live in the
 * OS-purgeable cache directory, so every uri the DB keeps must be copied into
 * app document storage or the "always kept" original silently disappears:
 *   - page 1     → the template filename itself (e.g. `2026-06-04_Acme_42.10.jpg`)
 *   - page n ≥ 2 → `<base>_p<n>.<ext>`
 *   - original   → `<base>_orig.<source ext>` (reuses page n's copy when the
 *                  original IS one of the pages, e.g. stitch mode)
 * `<base>` is derived from the ACTUAL saved primary name — which may carry a
 * collision suffix — so a receipt's files always travel as one family.
 *
 * After a successful copy each superseded source (cache temp, or an old
 * RECEIPTS_DIR file being renamed) is deleted best-effort so renames and
 * re-saves don't leak disk. Sources outside app-managed storage are never
 * touched. Every copy is best-effort: a failure keeps the source uri so the
 * receipt always references a real file.
 *
 * @returns The durable uris plus the ACTUAL primary filename (callers must
 *          store this — it may differ from the requested name on collision).
 */
export async function persistReceiptImages(input: {
  pageUris: string[];
  originalUri: string | null;
  /** Desired primary filename INCLUDING extension, from the user's template. */
  filename: string;
}): Promise<{ pageUris: string[]; originalUri: string | null; filename: string }> {
  const pages = input.pageUris.filter((u): u is string => !!u);
  const sources = new Set<string>(); // copied sources to clean up afterwards
  const outPages: string[] = [];

  // Primary page goes under the template name itself.
  let primaryUri: string | null = null;
  if (pages.length > 0) {
    primaryUri = await saveImageWithName(pages[0], input.filename);
    if (primaryUri !== pages[0]) sources.add(pages[0]);
    outPages.push(primaryUri);
  }

  // Derive the family base from the ACTUAL saved primary name (collision
  // suffix included); fall back to the requested name if the copy failed.
  const actualName =
    primaryUri && primaryUri.startsWith(RECEIPTS_DIR)
      ? primaryUri.slice(RECEIPTS_DIR.length)
      : input.filename;
  const dot = actualName.lastIndexOf('.');
  const stem = dot > 0 ? actualName.slice(0, dot) : actualName;
  const ext = dot > 0 ? actualName.slice(dot + 1) : 'jpg';

  // Pages 2..n → <base>_p<n>.<ext>.
  for (let i = 1; i < pages.length; i++) {
    const saved = await saveImageWithName(pages[i], `${stem}_p${i + 1}.${ext}`);
    if (saved !== pages[i]) sources.add(pages[i]);
    outPages.push(saved);
  }

  // Original: when it IS one of the pages (stitch mode passes the raw first
  // capture as both), reuse that page's durable copy instead of duplicating —
  // but only when the formats agree (a PDF "page" is saved under the template's
  // jpg/png name; the true original must keep its own extension and bytes).
  const norm = (e: string) => (e === 'jpeg' ? 'jpg' : e);
  let originalUri = input.originalUri;
  if (originalUri) {
    const pageIdx = pages.indexOf(originalUri);
    if (
      pageIdx >= 0 &&
      norm(extensionOf(originalUri)) === norm(extensionOf(outPages[pageIdx]))
    ) {
      originalUri = outPages[pageIdx];
    } else {
      // Keep the original's OWN extension (it may be a PNG photo or a PDF) so
      // the truly unprocessed bytes are stored verbatim, never transcoded.
      const origExt = extensionOf(originalUri) || ext;
      const saved = await saveImageWithName(originalUri, `${stem}_orig.${origExt}`);
      if (saved !== originalUri) sources.add(originalUri);
      originalUri = saved;
    }
  }

  // Clean up superseded sources that nothing references any more. Only files
  // in app-managed storage (cache temps, old RECEIPTS_DIR names) are deleted.
  const referenced = new Set<string>([...outPages, ...(originalUri ? [originalUri] : [])]);
  for (const src of sources) {
    if (referenced.has(src) || !isDeletableSource(src)) continue;
    await FileSystem.deleteAsync(src, { idempotent: true }).catch(() => {});
  }

  return { pageUris: outPages, originalUri, filename: actualName };
}

/**
 * Strip path separators and characters that are illegal on common filesystems,
 * so a user-authored filename template can't escape `RECEIPTS_DIR` or produce an
 * unwritable name. The template builder already produces friendly names; this is
 * a final safety net.
 */
function sanitizeFilename(name: string): string {
  const cleaned = name
    // Disallow directory traversal / separators.
    .replace(/[/\\]+/g, '_')
    // Disallow characters illegal on FAT/exFAT/NTFS and awkward in shells.
    .replace(/[:*?"<>|]+/g, '_')
    // Collapse whitespace runs to single underscores.
    .replace(/\s+/g, '_')
    .trim();
  // Never allow an empty name.
  return cleaned.length > 0 ? cleaned : `receipt_${Date.now()}.jpg`;
}
