/**
 * Pure de-skew geometry (TASK 10/38).
 *
 * Estimates the small rotation angle a photographed receipt is tilted by, from
 * the pixel bounding boxes of its OCR text blocks (the same ML Kit `frame`s the
 * region detector already uses — see src/services/receiptDetect.ts). NO native /
 * async deps so it is fully unit-testable; the image rotation itself is applied
 * by the image pipeline using `expo-image-manipulator`'s arbitrary-angle
 * `rotate` action.
 *
 * How it works: on an UPRIGHT receipt the text blocks are stacked vertically and
 * their centroids fall on a near-vertical line; when the receipt is rotated by θ
 * the column of centroids tilts by the same θ. We fit a line through the block
 * centroids by least squares and recover θ. Because receipts are tall and narrow
 * (one column of text), fitting x as a function of y is the stable orientation.
 *
 * We only correct SMALL skews (|θ| ≤ a cap): big rotations are handled
 * separately by the coarse 0/90/180/270 upright detector, and a large fitted
 * angle here usually means the blocks don't form a single clean column (multiple
 * receipts / sparse text), where rotating would do more harm than good.
 */
import type { BlockFrame } from './regions';

/** Skews smaller than this (degrees) aren't worth a re-encode. */
const MIN_CORRECTION_DEG = 0.75;
/** Never auto-rotate by more than this — bigger means "not a simple tilt". */
const MAX_CORRECTION_DEG = 15;
/** Need at least this many text blocks to trust a line fit. */
const MIN_BLOCKS = 4;

/**
 * Estimate the skew angle (in DEGREES) of a receipt from its OCR block frames.
 *
 * @param frames  Pixel-space text-block boxes from on-device OCR.
 * @returns       The tilt angle in degrees. POSITIVE means the receipt's text
 *                column leans clockwise from vertical (so the corrective rotation
 *                is the NEGATIVE of this). Returns 0 when there is too little
 *                signal to estimate (caller should leave the image as-is).
 */
export function estimateSkewAngle(frames: BlockFrame[]): number {
  const pts = (frames ?? [])
    .filter(
      (f) =>
        f &&
        Number.isFinite(f.left) &&
        Number.isFinite(f.top) &&
        f.width > 0 &&
        f.height > 0,
    )
    .map((f) => ({ x: f.left + f.width / 2, y: f.top + f.height / 2 }));

  if (pts.length < MIN_BLOCKS) return 0;

  // Least-squares fit of x = a*y + b (x as a function of y), so a vertical
  // column of centroids is well-conditioned. Slope `a` = tan(tilt from vertical).
  const n = pts.length;
  let sy = 0;
  let sx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    sy += p.y;
    sx += p.x;
    syy += p.y * p.y;
    sxy += p.x * p.y;
  }
  const denom = n * syy - sy * sy;
  // Degenerate column (all blocks share a y) — can't estimate a vertical tilt.
  if (Math.abs(denom) < 1e-6) return 0;

  const slope = (n * sxy - sy * sx) / denom; // dx/dy
  const angleDeg = (Math.atan(slope) * 180) / Math.PI;
  return Number.isFinite(angleDeg) ? angleDeg : 0;
}

/**
 * Compute the corrective rotation (in degrees, clockwise-positive to match
 * `expo-image-manipulator`) that straightens a receipt, or 0 when no correction
 * should be applied (too little signal, sub-threshold tilt, or an implausibly
 * large angle that isn't a simple skew).
 *
 * @param frames  Pixel-space OCR block frames.
 * @returns       Degrees to rotate the image to straighten it; 0 to leave as-is.
 */
export function deskewRotation(frames: BlockFrame[]): number {
  const skew = estimateSkewAngle(frames);
  const abs = Math.abs(skew);
  if (abs < MIN_CORRECTION_DEG || abs > MAX_CORRECTION_DEG) return 0;
  // The corrective rotation is the negative of the measured tilt.
  return -skew;
}
