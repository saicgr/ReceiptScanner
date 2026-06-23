/**
 * PieChart — a donut chart drawn with react-native-svg (no chart library).
 *
 * Each slice is an SVG <Path> arc whose sweep is proportional to its value. A
 * donut (inner radius) keeps the centre free for a headline total. Amounts are
 * NEVER formatted here — the caller formats labels through formatMoney and passes
 * pre-formatted strings (centerLabel / legend handled by the screen), so this
 * component stays currency-agnostic and reusable.
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Circle, G } from 'react-native-svg';
import { Text, useTheme } from '../ui';

export interface PieSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** Convert a polar point (degrees, clockwise from 12 o'clock) to x/y. */
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** SVG arc path for a donut segment between two angles. */
function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startDeg: number,
  endDeg: number,
): string {
  const [x1, y1] = polar(cx, cy, rOuter, endDeg);
  const [x2, y2] = polar(cx, cy, rOuter, startDeg);
  const [x3, y3] = polar(cx, cy, rInner, startDeg);
  const [x4, y4] = polar(cx, cy, rInner, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 0 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${large} 1 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}

export function PieChart({
  slices,
  size = 180,
  thickness = 34,
  centerTop,
  centerBottom,
}: {
  slices: PieSlice[];
  size?: number;
  thickness?: number;
  /** Small caption above the donut centre value (e.g. "TOTAL"). */
  centerTop?: string;
  /** Big centre value — caller formats it (formatMoney). */
  centerBottom?: string;
}) {
  const t = useTheme();
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2;
  const rInner = rOuter - thickness;

  const positives = slices.filter((s) => s.value > 0);
  const total = positives.reduce((sum, s) => sum + s.value, 0);

  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size}>
        {total <= 0 ? (
          // No data: a flat track ring so the chart still has presence.
          <Circle
            cx={cx}
            cy={cy}
            r={(rOuter + rInner) / 2}
            stroke={t.colors.surfaceAlt}
            strokeWidth={thickness}
            fill="none"
          />
        ) : (
          <G>
            {(() => {
              let angle = 0;
              return positives.map((s) => {
                const sweep = (s.value / total) * 360;
                // Guard against a full 360 path collapsing to nothing.
                const end = Math.min(angle + sweep, 359.999);
                const d = arcPath(cx, cy, rOuter, rInner, angle, end);
                angle += sweep;
                return <Path key={s.key} d={d} fill={s.color} />;
              });
            })()}
          </G>
        )}
      </Svg>
      {centerTop || centerBottom ? (
        <View style={{ position: 'absolute', alignItems: 'center' }}>
          {centerTop ? (
            <Text variant="caption" color={t.colors.textMuted}>
              {centerTop}
            </Text>
          ) : null}
          {centerBottom ? (
            <Text variant="subheading" numberOfLines={1}>
              {centerBottom}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
