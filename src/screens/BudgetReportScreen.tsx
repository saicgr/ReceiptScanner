/**
 * BudgetReportScreen — "Budget vs Actual" 12-month per-category comparison
 * (TASKS #45). For each budgeted category it renders a bar chart of monthly
 * actual spend with a dashed budget reference line, plus a summary of how many
 * of the last 12 months came in over budget.
 *
 * Per-currency: when budgets exist in more than one currency a switcher keeps the
 * comparison single-currency so amounts are never mixed. All money renders via
 * formatMoney.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import Svg, { Line } from 'react-native-svg';
import {
  Card,
  Chip,
  EmptyState,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '@/components/ui';
import { BarChart, type BarDatum } from '@/components/charts';
import * as DB from '@/db';
import { useSettings } from '@/store/settings';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import type { BudgetVsActual } from '@/types';

const CHART_H = 120;

export default function BudgetReportScreen() {
  const t = useTheme();
  const { settings } = useSettings();

  const [currencies, setCurrencies] = useState<string[]>([]);
  const [currency, setCurrency] = useState<string | null>(null);
  const [series, setSeries] = useState<BudgetVsActual[]>([]);
  const [loaded, setLoaded] = useState(false);

  const activeCurrency = useMemo(() => {
    if (currency && currencies.includes(currency)) return currency;
    return currencies[0] ?? settings.default_currency;
  }, [currency, currencies, settings.default_currency]);

  const load = useCallback(async () => {
    const curs = await DB.Budgets.budgetCurrencies();
    setCurrencies(curs);
    const cur = currency && curs.includes(currency) ? currency : curs[0] ?? settings.default_currency;
    setSeries(await DB.Budgets.budgetVsActual(cur));
    setLoaded(true);
  }, [currency, settings.default_currency]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <Screen scroll>
      <Text variant="title">Budget vs Actual</Text>
      <Text variant="body" color={t.colors.textMuted} style={{ marginTop: 4 }}>
        Last 12 months of actual spend per category against its monthly budget.
      </Text>

      {currencies.length > 1 ? (
        <Row gap={t.spacing.sm} wrap style={{ marginTop: t.spacing.md }}>
          {currencies.map((c) => (
            <Chip key={c} label={c} selected={c === activeCurrency} onPress={() => setCurrency(c)} />
          ))}
        </Row>
      ) : null}

      {!loaded ? null : series.length === 0 ? (
        <EmptyState
          icon="bar-chart-outline"
          title="No budgets set"
          message="Set a monthly budget for a category in Settings → Budgets to see how your spending compares."
        />
      ) : (
        series.map((s) => <CategoryReport key={s.categoryId} series={s} />)
      )}
    </Screen>
  );
}

function CategoryReport({ series }: { series: BudgetVsActual }) {
  const t = useTheme();
  const bars: BarDatum[] = series.months.map((m) => ({
    key: m.month,
    label: monthShort(m.month),
    value: m.spent,
    color: m.spent > series.budget ? t.colors.danger : t.colors.brandLight,
  }));

  const overCount = series.months.filter((m) => m.spent > series.budget).length;
  const avg =
    series.months.reduce((sum, m) => sum + m.spent, 0) / (series.months.length || 1);

  // Where the budget reference line sits inside the chart (same scale as bars).
  const max = Math.max(...series.months.map((m) => m.spent), series.budget, 0.01);
  const budgetY = CHART_H - (series.budget / max) * (CHART_H - 4);

  return (
    <>
      <SectionHeader title={series.categoryName} />
      <Card style={{ gap: t.spacing.sm }}>
        <Row justify="space-between">
          <Text variant="caption" color={t.colors.textMuted}>
            BUDGET / MO
          </Text>
          <Text weight="600">{formatMoney(series.budget, series.currency)}</Text>
        </Row>

        {/* Bar chart with a dashed budget reference line overlaid. */}
        <View>
          <BarChart data={bars} height={CHART_H} highlightPeak={false} labelEvery={2} />
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, height: CHART_H }} pointerEvents="none">
            <Svg width="100%" height={CHART_H}>
              <Line
                x1="0"
                y1={budgetY}
                x2="100%"
                y2={budgetY}
                stroke={t.colors.danger}
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            </Svg>
          </View>
        </View>

        <Row justify="space-between" style={{ marginTop: t.spacing.xs }}>
          <View>
            <Text variant="caption" color={t.colors.textMuted}>
              AVG / MO
            </Text>
            <Text weight="600">{formatMoney(avg, series.currency)}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text variant="caption" color={t.colors.textMuted}>
              MONTHS OVER
            </Text>
            <Text weight="600" color={overCount > 0 ? t.colors.danger : t.colors.success}>
              {overCount} / 12
            </Text>
          </View>
        </Row>
      </Card>
    </>
  );
}

/** "YYYY-MM" -> short month label, anchored to the 1st for formatDate. */
function monthShort(month: string): string {
  return formatDate(`${month}-01`, 'MMM');
}
