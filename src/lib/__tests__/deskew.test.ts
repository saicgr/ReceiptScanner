/**
 * Unit tests for src/lib/deskew.ts — pure skew-angle estimation (TASK 10/38).
 */
import { estimateSkewAngle, deskewRotation } from '../deskew';
import type { BlockFrame } from '../regions';

/**
 * Build a vertical column of text blocks whose centroids are rotated by `deg`
 * about the column's midpoint — simulating a receipt photographed at a tilt.
 */
function tiltedColumn(deg: number, count = 8): BlockFrame[] {
  const rad = (deg * Math.PI) / 180;
  const cx = 500;
  const cy = 500;
  const frames: BlockFrame[] = [];
  for (let i = 0; i < count; i++) {
    // Centroid before rotation: a straight vertical line of points.
    const y0 = i * 80 - (count - 1) * 40; // centered on 0
    const x0 = 0;
    // Rotate (x0,y0) clockwise by `deg` (image y grows downward).
    const x = x0 * Math.cos(rad) - y0 * Math.sin(rad) + cx;
    const y = x0 * Math.sin(rad) + y0 * Math.cos(rad) + cy;
    const w = 200;
    const h = 30;
    frames.push({ left: x - w / 2, top: y - h / 2, width: w, height: h });
  }
  return frames;
}

describe('estimateSkewAngle', () => {
  it('returns 0 for an upright column', () => {
    expect(Math.abs(estimateSkewAngle(tiltedColumn(0)))).toBeLessThan(0.2);
  });

  it('returns ~0 when there are too few blocks to trust a fit', () => {
    expect(estimateSkewAngle(tiltedColumn(5, 3))).toBe(0);
    expect(estimateSkewAngle([])).toBe(0);
  });

  it('recovers a tilt of the expected magnitude (5 degrees)', () => {
    const a = estimateSkewAngle(tiltedColumn(5));
    expect(Math.abs(a)).toBeGreaterThan(4);
    expect(Math.abs(a)).toBeLessThan(6);
  });

  it('recovers a tilt in the opposite direction with opposite sign', () => {
    const pos = estimateSkewAngle(tiltedColumn(5));
    const neg = estimateSkewAngle(tiltedColumn(-5));
    // Equal magnitude, opposite sign.
    expect(Math.sign(pos)).toBe(-Math.sign(neg));
    expect(Math.abs(Math.abs(pos) - Math.abs(neg))).toBeLessThan(0.01);
  });

  it('ignores degenerate / invalid frames', () => {
    const bad: BlockFrame[] = [
      { left: NaN, top: 0, width: 10, height: 10 },
      { left: 0, top: 0, width: 0, height: 10 },
    ];
    expect(estimateSkewAngle(bad)).toBe(0);
  });
});

describe('deskewRotation', () => {
  it('does not correct a sub-threshold tilt', () => {
    expect(deskewRotation(tiltedColumn(0.3))).toBe(0);
  });

  it('returns the NEGATIVE of the measured tilt for a correctable skew', () => {
    const measured = estimateSkewAngle(tiltedColumn(6));
    const r = deskewRotation(tiltedColumn(6));
    // The corrective rotation undoes the measured tilt.
    expect(r).toBeCloseTo(-measured, 5);
    expect(Math.abs(r)).toBeGreaterThan(5);
    expect(Math.abs(r)).toBeLessThan(7);
  });

  it('refuses to correct an implausibly large angle (not a simple skew)', () => {
    expect(deskewRotation(tiltedColumn(40))).toBe(0);
  });
});
