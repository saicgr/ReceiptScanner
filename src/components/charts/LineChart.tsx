/**
 * LineChart — a spending trend line drawn with react-native-svg. A filled area
 * under the polyline plus point markers. Used for the spending-trend-over-time
 * chart (monthly trend) and shareable by any time series.
 *
 * Values are plain numbers; currency formatting stays with the caller (formatMoney
 * for the peak label / axis captions).
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Polyline, Polygon, Circle, Line } from 'react-native-svg';
import { Row, Text, useTheme } from '../ui';

export interface LinePoint {
  key: string;
  label: string;
  value: number;
}

export function LineChart({
  data,
  height = 150,
  caption,
  peakLabel,
  labelEvery = 1,
}: {
  data: LinePoint[];
  height?: number;
  caption?: string;
  peakLabel?: string;
  labelEvery?: number;
}) {
  const t = useTheme();
  if (!data.length) {
    return (
      <Text variant="caption" color={t.colors.textMuted} align="center">
        No data in this range.
      </Text>
    );
  }

  // A single point can't form a line — fall back to a centered marker.
  const max = Math.max(...data.map((d) => d.value), 0.01);
  const n = data.length;
  const pad = 6; // vertical padding so markers aren't clipped
  const plotH = height;

  // Use a 0..100 viewBox-style coordinate space on X (percent), pixels on Y.
  const xAt = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const yAt = (v: number) => plotH - pad - (v / max) * (plotH - pad * 2);

  const points = data.map((d, i) => `${xAt(i)},${yAt(d.value)}`).join(' ');
  // Area polygon: the line points plus the two bottom corners.
  const area = `${xAt(0)},${plotH} ${points} ${xAt(n - 1)},${plotH}`;

  return (
    <View style={{ gap: t.spacing.sm }}>
      {caption || peakLabel ? (
        <Row justify="space-between">
          {caption ? (
            <Text variant="caption" color={t.colors.textMuted}>
              {caption}
            </Text>
          ) : (
            <View />
          )}
          {peakLabel ? (
            <Text variant="caption" weight="600">
              {peakLabel}
            </Text>
          ) : null}
        </Row>
      ) : null}

      <Svg width="100%" height={plotH} viewBox={`0 0 100 ${plotH}`} preserveAspectRatio="none">
        {/* baseline */}
        <Line x1={0} y1={plotH - 0.5} x2={100} y2={plotH - 0.5} stroke={t.colors.border} strokeWidth={0.4} />
        <Polygon points={area} fill={t.colors.brand} fillOpacity={0.12} />
        {n > 1 ? (
          <Polyline
            points={points}
            fill="none"
            stroke={t.colors.brand}
            strokeWidth={1.4}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {data.map((d, i) => (
          <Circle key={d.key} cx={xAt(i)} cy={yAt(d.value)} r={1.6} fill={t.colors.brand} />
        ))}
      </Svg>

      <Row justify="space-between" align="flex-start">
        {data.map((d, i) => (
          <View key={d.key} style={{ flex: 1, alignItems: 'center' }}>
            {i % labelEvery === 0 ? (
              <Text variant="caption" color={t.colors.textMuted} numberOfLines={1}>
                {d.label}
              </Text>
            ) : null}
          </View>
        ))}
      </Row>
    </View>
  );
}
