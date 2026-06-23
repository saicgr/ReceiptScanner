/**
 * BarChart — vertical bars drawn with react-native-svg. Used for monthly spending
 * and daily spending patterns. Bar heights scale to the largest value in the set.
 *
 * Values are plain numbers; the component never formats currency. The caller
 * supplies short x-axis labels (month abbreviations / day numbers) and may pass a
 * pre-formatted `peakLabel` (via formatMoney) rendered above the chart.
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { Row, Text, useTheme } from '../ui';

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  /** Optional per-bar color; falls back to the brand color. */
  color?: string;
}

export function BarChart({
  data,
  height = 140,
  /** Highlight the tallest bar in the accent color. */
  highlightPeak = true,
  /** Caption rendered top-left (e.g. "Peak"). */
  caption,
  /** Pre-formatted value rendered top-right (caller uses formatMoney). */
  peakLabel,
  /** Show every Nth label to avoid crowding (1 = all). */
  labelEvery = 1,
}: {
  data: BarDatum[];
  height?: number;
  highlightPeak?: boolean;
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

  const max = Math.max(...data.map((d) => d.value), 0.01);
  const peakIdx = data.reduce(
    (best, d, i) => (d.value > data[best].value ? i : best),
    0,
  );

  // Layout: evenly spaced bars with a small gap, full available width via 100%.
  const n = data.length;
  const slot = 100 / n; // percent width per bar slot
  const barW = Math.max(2, slot * 0.62);
  const plotH = height;

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

      <Svg width="100%" height={plotH}>
        {data.map((d, i) => {
          const h = Math.max(2, (d.value / max) * (plotH - 4));
          const xCenter = slot * i + slot / 2;
          const x = xCenter - barW / 2;
          const isPeak = highlightPeak && i === peakIdx;
          const fill =
            d.color ?? (isPeak ? t.colors.brand : t.colors.brandLight);
          return (
            <Rect
              key={d.key}
              x={`${x}%`}
              y={plotH - h}
              width={`${barW}%`}
              height={h}
              rx={3}
              fill={fill}
            />
          );
        })}
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
