/**
 * QrCode — renders a QR module matrix to SVG (react-native-svg, already a dep).
 *
 * The matrix comes from the pure encoder in src/lib/qrEncode.ts; this component
 * is purely presentational. We draw each dark module as a <Rect> on a quiet-zone
 * padded white background so any scanner reads it reliably. On an encode error
 * (e.g. payload too large) the caller should fall back BEFORE rendering — this
 * component renders nothing for an empty/failed matrix.
 */
import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { encodeQr, type QrEcLevel } from '@/lib/qrEncode';

export function QrCode({
  value,
  size = 240,
  ecLevel = 'L',
  quietZone = 4,
  color = '#000000',
  background = '#FFFFFF',
}: {
  value: string;
  size?: number;
  ecLevel?: QrEcLevel;
  /** Quiet-zone border width in modules (spec minimum is 4). */
  quietZone?: number;
  color?: string;
  background?: string;
}) {
  const matrix = useMemo(() => {
    try {
      return encodeQr(value, ecLevel);
    } catch {
      // Oversize / invalid — render nothing; callers handle the fallback.
      return null;
    }
  }, [value, ecLevel]);

  if (!matrix) return null;

  const total = matrix.size + quietZone * 2;
  const cell = size / total;

  // Coalesce horizontal runs of dark modules into single rects to keep the SVG
  // node count low (a v40 code is 177x177 modules).
  const rects: { x: number; y: number; w: number }[] = [];
  for (let r = 0; r < matrix.size; r++) {
    let runStart = -1;
    for (let c = 0; c <= matrix.size; c++) {
      const dark = c < matrix.size && matrix.modules[r][c];
      if (dark && runStart === -1) runStart = c;
      else if (!dark && runStart !== -1) {
        rects.push({ x: runStart, y: r, w: c - runStart });
        runStart = -1;
      }
    }
  }

  return (
    <View style={{ width: size, height: size, backgroundColor: background }}>
      <Svg width={size} height={size} viewBox={`0 0 ${total} ${total}`}>
        <Rect x={0} y={0} width={total} height={total} fill={background} />
        {rects.map((run, i) => (
          <Rect
            key={i}
            x={run.x + quietZone}
            y={run.y + quietZone}
            width={run.w}
            height={1}
            fill={color}
          />
        ))}
      </Svg>
    </View>
  );
}
