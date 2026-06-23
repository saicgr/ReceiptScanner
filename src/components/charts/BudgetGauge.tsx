/**
 * BudgetGauge — a single colored budget progress bar (green -> amber -> red based
 * on spend vs budget). Drawn with plain Views (a track + a filled portion); the
 * fill color comes from the BudgetStatus.level traffic light.
 *
 * Money is ALWAYS rendered through formatMoney(amount, currency) — never a bare
 * number or interpolated symbol.
 */
import React from 'react';
import { View } from 'react-native';
import { Row, Text, useTheme } from '../ui';
import { formatMoney } from '../../lib/money';
import type { BudgetStatus } from '../../types';

export function gaugeColor(level: BudgetStatus['level'], t: ReturnType<typeof useTheme>): string {
  switch (level) {
    case 'over':
      return t.colors.danger;
    case 'near':
      return t.colors.warning;
    case 'under':
    default:
      return t.colors.success;
  }
}

export function BudgetGauge({ status }: { status: BudgetStatus }) {
  const t = useTheme();
  const color = gaugeColor(status.level, t);
  // Cap the visible fill at 100% even when over budget (color already signals it).
  const pct = Math.min(100, Math.max(2, Math.round(status.ratio * 100)));
  const overspent = status.remaining < 0;

  return (
    <View style={{ gap: 6 }}>
      <Row justify="space-between">
        <Row gap={t.spacing.sm} style={{ flex: 1, marginRight: t.spacing.sm }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: status.color || t.colors.brand,
            }}
          />
          <Text numberOfLines={1} style={{ flex: 1 }}>
            {status.categoryName}
          </Text>
        </Row>
        <Text weight="600">
          {formatMoney(status.spent, status.currency)}
          <Text color={t.colors.textMuted}>
            {' / '}
            {formatMoney(status.budget, status.currency)}
          </Text>
        </Text>
      </Row>

      <View
        style={{
          height: 8,
          borderRadius: 4,
          backgroundColor: t.colors.surfaceAlt,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 4,
            backgroundColor: color,
          }}
        />
      </View>

      <Text variant="caption" color={overspent ? t.colors.danger : t.colors.textMuted}>
        {overspent
          ? `Over by ${formatMoney(Math.abs(status.remaining), status.currency)}`
          : `${formatMoney(status.remaining, status.currency)} left · ${Math.round(status.ratio * 100)}%`}
      </Text>
    </View>
  );
}
