/**
 * Pure receipt-region geometry — the math behind on-device multi-receipt
 * detection and cropping. NO native / async deps so it is fully unit-testable.
 *
 * The on-device detector (src/services/receiptDetect.ts) runs ML Kit text
 * recognition over a photo and hands the resulting text-block bounding boxes
 * here. `clusterBlocksIntoRegions` groups blocks that sit close together into
 * one receipt each (text lines within a receipt are near each other; separate
 * receipts are divided by background), and returns one normalized box per group.
 * `regionToPixelRect` then converts a normalized box back to a pixel crop rect
 * for `expo-image-manipulator`.
 *
 * Everything is heuristic by design — the user always reviews the resulting
 * crops and can drop a wrong split — so we favour simple, predictable rules.
 */
import type { DetectedRegion } from '@/types';

/** A pixel-space rectangle, matching ML Kit's text-block `frame`. */
export interface BlockFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A pixel-space crop rectangle for `ImageManipulator`'s `crop` action. */
export interface PixelRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface ClusterOptions {
  /** Two blocks join the same receipt when their gap is within this fraction of
   *  the image's longer edge. Larger ⇒ more aggressive merging. */
  mergeGapFrac?: number;
  /** Padding added around each cluster's union box (fraction of image size). */
  regionPaddingFrac?: number;
  /** Drop a region whose normalized width OR height is below this. */
  minSizeFrac?: number;
}

const DEFAULTS = {
  mergeGapFrac: 0.05,
  regionPaddingFrac: 0.015,
  minSizeFrac: 0.06,
} as const;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** True when rect `a`, grown by (gapX, gapY) on every side, overlaps rect `b`. */
function within(a: BlockFrame, b: BlockFrame, gapX: number, gapY: number): boolean {
  const aRight = a.left + a.width;
  const aBottom = a.top + a.height;
  const bRight = b.left + b.width;
  const bBottom = b.top + b.height;
  return (
    a.left - gapX < bRight &&
    aRight + gapX > b.left &&
    a.top - gapY < bBottom &&
    aBottom + gapY > b.top
  );
}

/**
 * Cluster OCR text-block frames into one normalized region per receipt.
 *
 * @param frames  Pixel-space block boxes from on-device OCR.
 * @param imgW    Source image width in px.
 * @param imgH    Source image height in px.
 * @returns       Normalized (0..1) regions, ordered top→bottom then left→right.
 *                Empty when there are no usable blocks (caller falls back to the
 *                full image). A single cluster yields a single region (which is
 *                effectively a tight auto-crop of one receipt).
 */
export function clusterBlocksIntoRegions(
  frames: BlockFrame[],
  imgW: number,
  imgH: number,
  opts: ClusterOptions = {},
): DetectedRegion[] {
  const mergeGapFrac = opts.mergeGapFrac ?? DEFAULTS.mergeGapFrac;
  const regionPaddingFrac = opts.regionPaddingFrac ?? DEFAULTS.regionPaddingFrac;
  const minSizeFrac = opts.minSizeFrac ?? DEFAULTS.minSizeFrac;

  if (!(imgW > 0) || !(imgH > 0)) return [];

  // Keep only real, positive-area boxes that sit within the image.
  const valid = frames.filter(
    (f) =>
      f &&
      Number.isFinite(f.left) &&
      Number.isFinite(f.top) &&
      f.width > 0 &&
      f.height > 0,
  );
  if (valid.length === 0) return [];

  // Gap threshold scaled to the larger edge so it behaves the same regardless of
  // photo resolution or orientation.
  const gap = mergeGapFrac * Math.max(imgW, imgH);

  // Union-find over blocks; O(n²) is fine for the tens–hundreds of blocks OCR
  // returns for a page of receipts.
  const parent = valid.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      if (within(valid[i], valid[j], gap, gap)) union(i, j);
    }
  }

  // Collect each cluster's union bounding box.
  const boxes = new Map<number, { left: number; top: number; right: number; bottom: number }>();
  valid.forEach((f, i) => {
    const root = find(i);
    const r = f.left + f.width;
    const b = f.top + f.height;
    const cur = boxes.get(root);
    if (!cur) {
      boxes.set(root, { left: f.left, top: f.top, right: r, bottom: b });
    } else {
      cur.left = Math.min(cur.left, f.left);
      cur.top = Math.min(cur.top, f.top);
      cur.right = Math.max(cur.right, r);
      cur.bottom = Math.max(cur.bottom, b);
    }
  });

  const padX = regionPaddingFrac * imgW;
  const padY = regionPaddingFrac * imgH;

  const regions: DetectedRegion[] = [];
  for (const box of boxes.values()) {
    const left = clamp01((box.left - padX) / imgW);
    const top = clamp01((box.top - padY) / imgH);
    const right = clamp01((box.right + padX) / imgW);
    const bottom = clamp01((box.bottom + padY) / imgH);
    const width = right - left;
    const height = bottom - top;
    // Drop sliver/noise clusters that are too small to be a receipt.
    if (width < minSizeFrac || height < minSizeFrac) continue;
    regions.push({ x: left, y: top, width, height });
  }

  // Reading order: top→bottom, then left→right (stable #1..#N labels in the UI).
  regions.sort((a, b) => (Math.abs(a.y - b.y) > 0.05 ? a.y - b.y : a.x - b.x));
  return regions;
}

/**
 * Convert a normalized region to an integer pixel crop rect, clamped to the
 * image. `paddingFrac` expands the box on every side (fraction of image size).
 */
export function regionToPixelRect(
  region: DetectedRegion,
  imgW: number,
  imgH: number,
  paddingFrac = 0,
): PixelRect {
  const padX = paddingFrac * imgW;
  const padY = paddingFrac * imgH;

  let left = region.x * imgW - padX;
  let top = region.y * imgH - padY;
  let width = region.width * imgW + 2 * padX;
  let height = region.height * imgH + 2 * padY;

  // Clamp the origin into the image, then trim the size to stay in bounds.
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (left > imgW - 1) left = imgW - 1;
  if (top > imgH - 1) top = imgH - 1;
  if (left + width > imgW) width = imgW - left;
  if (top + height > imgH) height = imgH - top;

  return {
    originX: Math.round(left),
    originY: Math.round(top),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/** Whether a detection result indicates more than one distinct receipt. */
export function hasMultipleReceipts(regions: DetectedRegion[]): boolean {
  return regions.length > 1;
}
