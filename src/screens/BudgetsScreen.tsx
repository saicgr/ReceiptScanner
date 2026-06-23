/**
 * BudgetsScreen — set a per-category MONTHLY budget amount (TASKS #45).
 *
 * Each category gets one editable budget in the user's default currency. Setting
 * an amount of 0 clears the budget. The Home screen reads these back as colored
 * gauges, and the Statistics "Budget vs Actual" view compares them over 12
 * months. All amounts render/parse through the money lib — never a bare number.
 */
import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  Button,
  Card,
  Divider,
  EmptyState,
  Icon,
  MoneyInput,
  Row,
  Screen,
  SectionHeader,
  Text,
  useTheme,
  type IconName,
} from '@/components/ui';
import * as DB from '@/db';
import { useSettings } from '@/store/settings';
import { useLookups } from '@/store/lookups';
import { formatMoney } from '@/lib/money';
import type { Category, CategoryBudget } from '@/types';

export default function BudgetsScreen() {
  const t = useTheme();
  const { settings } = useSettings();
  const currency = settings.default_currency;

  const [categories, setCategories] = useState<Category[]>([]);
  const [budgets, setBudgets] = useState<Map<string, number>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [cats, rows] = await Promise.all([DB.listCategories(), DB.Budgets.listBudgets()]);
    const map = new Map<string, number>();
    rows
      .filter((b: CategoryBudget) => b.currency === currency)
      .forEach((b: CategoryBudget) => map.set(b.category_id, b.amount));
    setCategories(cats);
    setBudgets(map);
    setLoaded(true);
  }, [currency]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onCommit = async (categoryId: string, amount: number | null) => {
    setSaving(true);
    try {
      await DB.Budgets.setBudget(categoryId, amount ?? 0, currency);
      // Mirror the change locally so the field shows the committed value at once.
      setBudgets((prev) => {
        const next = new Map(prev);
        if (amount && amount > 0) next.set(categoryId, amount);
        else next.delete(categoryId);
        return next;
      });
    } finally {
      setSaving(false);
    }
  };

  const totalBudget = Array.from(budgets.values()).reduce((s, v) => s + v, 0);

  return (
    <Screen scroll>
      <Text variant="title">Budgets</Text>
      <Text variant="body" color={t.colors.textMuted} style={{ marginTop: 4 }}>
        Set a monthly cap per category (in {currency}). Home shows colored gauges and
        Statistics compares budget vs actual over 12 months.
      </Text>

      {!loaded ? (
        <Text variant="body" color={t.colors.textMuted} style={{ marginTop: t.spacing.lg }}>
          Loading…
        </Text>
      ) : categories.length === 0 ? (
        <EmptyState
          icon="pie-chart-outline"
          title="No categories yet"
          message="Create categories first, then set a monthly budget for each."
          action="Manage categories"
          onAction={() => router.push('/settings/categories')}
        />
      ) : (
        <>
          <Card style={{ marginTop: t.spacing.lg }}>
            <Text variant="caption" color={t.colors.textMuted}>
              TOTAL MONTHLY BUDGET
            </Text>
            <Text variant="title" color={t.colors.brand}>
              {formatMoney(totalBudget, currency)}
            </Text>
          </Card>

          <SectionHeader title="Per category" />
          <Card>
            {categories.map((c, i) => (
              <View key={c.id}>
                {i > 0 ? <Divider spacing={t.spacing.sm} /> : null}
                <Row gap={t.spacing.md} align="center">
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: t.radius.md,
                      backgroundColor: c.color + '22',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name={c.icon as IconName} size={18} color={c.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text weight="600" numberOfLines={1}>
                      {c.name}
                    </Text>
                  </View>
                  <View style={{ width: 130 }}>
                    <MoneyInput
                      value={budgets.get(c.id) ?? null}
                      onCommit={(v) => onCommit(c.id, v)}
                      prefix={currency}
                      placeholder="0.00"
                      style={{ marginBottom: 0 }}
                    />
                  </View>
                </Row>
              </View>
            ))}
          </Card>

          <Button
            title="View Budget vs Actual"
            icon="bar-chart-outline"
            variant="secondary"
            style={{ marginTop: t.spacing.lg }}
            onPress={() => router.push('/budget-report')}
            loading={saving && false}
          />
        </>
      )}
    </Screen>
  );
}
