/**
 * Unit tests for src/lib/regions.ts — the pure geometry behind on-device
 * multi-receipt detection and cropping.
 *
 * Covers: clustering separated text blocks into N receipts, collapsing a single
 * tight group into one region, dropping sliver/noise clusters, reading-order
 * sorting, and the normalized→pixel crop-rect conversion (padding + clamping).
 */
import {
  clusterBlocksIntoRegions,
  regionToPixelRect,
  hasMultipleReceipts,
  type BlockFrame,
} from '../regions';

/** Build a column of stacked text-line frames (one receipt's worth). */
function receiptBlocks(left: number, top: number, w = 200, lineH = 30, lines = 6): BlockFrame[] {
  return Array.from({ length: lines }, (_, i) => ({
    left,
    top: top + i * (lineH + 4),
    width: w,
    height: lineH,
  }));
}

const IMG_W = 1000;
const IMG_H = 2000;

describe('clusterBlocksIntoRegions', () => {
  it('returns [] when there are no usable blocks', () => {
    expect(clusterBlocksIntoRegions([], IMG_W, IMG_H)).toEqual([]);
    expect(
      clusterBlocksIntoRegions([{ left: 0, top: 0, width: 0, height: 0 }], IMG_W, IMG_H),
    ).toEqual([]);
  });

  it('collapses one tight group of lines into a single region', () => {
    const regions = clusterBlocksIntoRegions(receiptBlocks(100, 100), IMG_W, IMG_H);
    expect(regions).toHaveLength(1);
    expect(hasMultipleReceipts(regions)).toBe(false);
    // The region should roughly bound the block column (with a little padding).
    expect(regions[0].x).toBeLessThan(100 / IMG_W);
    expect(regions[0].width).toBeGreaterThan(0.15);
  });

  it('splits two well-separated receipts into two regions', () => {
    // Left receipt near x=80; right receipt near x=700 — a wide background gap.
    const blocks = [...receiptBlocks(80, 120), ...receiptBlocks(700, 140)];
    const regions = clusterBlocksIntoRegions(blocks, IMG_W, IMG_H);
    expect(regions).toHaveLength(2);
    expect(hasMultipleReceipts(regions)).toBe(true);
    // Reading order: both start near the same y, so sorted left→right.
    expect(regions[0].x).toBeLessThan(regions[1].x);
  });

  it('orders three receipts top→bottom then left→right', () => {
    const topLeft = receiptBlocks(80, 80);
    const topRight = receiptBlocks(700, 90);
    const bottom = receiptBlocks(80, 1200);
    const regions = clusterBlocksIntoRegions([...bottom, ...topRight, ...topLeft], IMG_W, IMG_H);
    expect(regions).toHaveLength(3);
    // First two are the top row (left then right), last is the bottom one.
    expect(regions[0].y).toBeLessThan(0.2);
    expect(regions[1].y).toBeLessThan(0.2);
    expect(regions[0].x).toBeLessThan(regions[1].x);
    expect(regions[2].y).toBeGreaterThan(0.5);
  });

  it('drops sliver/noise clusters below the minimum size', () => {
    const realReceipt = receiptBlocks(80, 120);
    const noise: BlockFrame = { left: 950, top: 1900, width: 8, height: 8 }; // tiny speck
    const regions = clusterBlocksIntoRegions([...realReceipt, noise], IMG_W, IMG_H);
    expect(regions).toHaveLength(1); // the speck is dropped
  });
});

describe('regionToPixelRect', () => {
  it('converts a normalized region to a pixel rect', () => {
    const rect = regionToPixelRect({ x: 0.1, y: 0.2, width: 0.5, height: 0.25 }, 1000, 2000);
    expect(rect).toEqual({ originX: 100, originY: 400, width: 500, height: 500 });
  });

  it('clamps padding so the rect never leaves the image', () => {
    // A region flush against the top-left, padded — origin clamps to 0,0.
    const rect = regionToPixelRect({ x: 0, y: 0, width: 0.5, height: 0.5 }, 1000, 1000, 0.1);
    expect(rect.originX).toBe(0);
    expect(rect.originY).toBe(0);
    expect(rect.originX + rect.width).toBeLessThanOrEqual(1000);
    expect(rect.originY + rect.height).toBeLessThanOrEqual(1000);
  });

  it('keeps a full-image region within bounds', () => {
    const rect = regionToPixelRect({ x: 0, y: 0, width: 1, height: 1 }, 800, 600);
    expect(rect).toEqual({ originX: 0, originY: 0, width: 800, height: 600 });
  });

  it('never produces a zero-size rect', () => {
    const rect = regionToPixelRect({ x: 0.999, y: 0.999, width: 0.0001, height: 0.0001 }, 1000, 1000);
    expect(rect.width).toBeGreaterThanOrEqual(1);
    expect(rect.height).toBeGreaterThanOrEqual(1);
  });
});
