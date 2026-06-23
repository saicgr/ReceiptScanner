/**
 * Statistics — where ReceiptSnap out-classes the competitor that "only showed
 * totals". We surface a rich, fully itemized analytics view built entirely from
 * the richer DAO aggregates:
 *   - headline card (total, average, highest receipt, most-frequent vendor)
 *   - per-currency switching (statistics group totals by currency CORRECTLY)
 *   - spend by category / company / payment method / item as horizontal bars
 *   - a monthly trend rendered as vertical bars
 * No chart library: every bar is a plain <View> whose width/height is a % of the
 * group's max, so the bundle stays tiny and offline-first.
 *
 * EVERY amount renders through formatMoney(amount, currency) — never a bare
 * number and never the literal "not found" string a competitor once shipped.
 */
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  Screen,
  Card,
  Button,
  Text,
  Row,
  SectionHeader,
  Chip,
  EmptyState,
  Divider,
  useTheme,
  type Theme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import * as DB from '@/db';
import { PieChart, BarChart, LineChart, type PieSlice, type BarDatum, type LinePoint } from '@/components/charts';
import { formatMoney, round2 } from '@/lib/money';
import { formatDate, todayIso } from '@/lib/dates';
import type {
  QuickStats,
  CurrencyTotal,
  CategorySpend,
  MonthlySpend,
  DailySpend,
  GroupedSpend,
  ExportFilter,
  MileageTrip,
} from '@/types';

// ---------------------------------------------------------------------------
// Date-range presets — these feed the ExportFilter passed to every DAO call.
// ---------------------------------------------------------------------------
type RangeKey = 'all' | 'month' | 'year' | 'days30';

const RANGE_OPTIONS: { label: string; value: RangeKey }[] = [
  { label: 'All', value: 'all' },
  { label: 'This month', value: 'month' },
  { label: 'This year', value: 'year' },
  { label: '30 days', value: 'days30' },
];

/** Translate a preset into the {startDate,endDate} the aggregates understand. */
function rangeToFilter(range: RangeKey): Pick<ExportFilter, 'startDate' | 'endDate'> {
  const today = todayIso(); // YYYY-MM-DD
  switch (range) {
    case 'month':
      return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
    case 'year':
      return { startDate: `${today.slice(0, 4)}-01-01`, endDate: today };
    case 'days30': {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      const start = d.toISOString().slice(0, 10);
      return { startDate: start, endDate: today };
    }
    case 'all':
    default:
      return {};
  }
}

export default function StatisticsScreen() {
  const t = useTheme();
  const { settings } = useSettings();

  const [range, setRange] = useState<RangeKey>('all');
  const [currency, setCurrency] = useState<string | null>(null);

  // Raw aggregates straight from the DAO — refreshed whenever the range changes.
  const [quick, setQuick] = useState<QuickStats[]>([]);
  const [currencyTotals, setCurrencyTotals] = useState<CurrencyTotal[]>([]);
  const [byCategory, setByCategory] = useState<CategorySpend[]>([]);
  const [byCompany, setByCompany] = useState<GroupedSpend[]>([]);
  const [byPayment, setByPayment] = useState<GroupedSpend[]>([]);
  const [bySubcategory, setBySubcategory] = useState<GroupedSpend[]>([]);
  const [byItem, setByItem] = useState<GroupedSpend[]>([]);
  const [byMonth, setByMonth] = useState<MonthlySpend[]>([]);
  const [byDay, setByDay] = useState<DailySpend[]>([]);
  const [trips, setTrips] = useState<MileageTrip[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const f = rangeToFilter(range);
    const [q, ct, cat, comp, pay, sub, item, month, day, allTrips] = await Promise.all([
      DB.quickStats(f),
      DB.totalsByCurrency(f),
      DB.spendByCategory(f),
      DB.spendByCompany(f),
      DB.spendByPaymentMethod(f),
      DB.spendBySubcategory(f),
      DB.spendByItem(f),
      DB.spendByMonth(f),
      DB.spendByDay(f),
      DB.Mileage.listTrips(),
    ]);
    setQuick(q);
    setCurrencyTotals(ct);
    setByCategory(cat);
    setByCompany(comp);
    setByPayment(pay);
    setBySubcategory(sub);
    setByItem(item);
    setByMonth(month);
    setByDay(day);
    // Mileage has no SQL date filter — apply the same range in JS on the
    // trip's start date so it tracks the selected chips like everything else.
    setTrips(
      allTrips.filter((tr) => {
        const d = tr.start_time?.slice(0, 10) ?? '';
        return (!f.startDate || d >= f.startDate) && (!f.endDate || d <= f.endDate);
      }),
    );
    setLoaded(true);
  }, [range]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Pick the active currency: keep the user's choice if it still has data,
  // otherwise default to the largest-spend currency in the result set.
  const currencies = useMemo(() => currencyTotals.map((c) => c.currency), [currencyTotals]);
  const activeCurrency = useMemo(() => {
    if (currency && currencies.includes(currency)) return currency;
    return currencies[0] ?? settings.default_currency;
  }, [currency, currencies, settings.default_currency]);

  // Slice every aggregate down to the currency the user is viewing so totals
  // are NEVER mixed across currencies (a correctness bug we explicitly avoid).
  const cur = activeCurrency;
  const headline = useMemo(() => quick.find((q) => q.currency === cur) ?? null, [quick, cur]);
  const catRows = useMemo(() => byCategory.filter((r) => r.currency === cur), [byCategory, cur]);
  const companyRows = useMemo(() => byCompany.filter((r) => r.currency === cur), [byCompany, cur]);
  const paymentRows = useMemo(() => byPayment.filter((r) => r.currency === cur), [byPayment, cur]);
  const subcategoryRows = useMemo(() => bySubcategory.filter((r) => r.currency === cur), [bySubcategory, cur]);
  const itemRows = useMemo(() => byItem.filter((r) => r.currency === cur), [byItem, cur]);
  const monthRows = useMemo(() => byMonth.filter((r) => r.currency === cur), [byMonth, cur]);
  const dayRows = useMemo(() => byDay.filter((r) => r.currency === cur), [byDay, cur]);

  // Mileage roll-up for the range ("mileage entries flow into reports"). Trips
  // carry no currency of their own — amounts are always in the default currency.
  const mileage = useMemo(
    () => ({
      count: trips.length,
      miles: round2(trips.reduce((s, tr) => s + tr.distance_miles, 0)),
      amount: round2(trips.reduce((s, tr) => s + tr.amount, 0)),
    }),
    [trips],
  );

  const hasData = currencyTotals.length > 0;

  return (
    <Screen scroll edges={['top']}>
      <Text variant="title">Statistics</Text>

      {/* Date-range chips drive every aggregate query. */}
      <Row gap={t.spacing.sm} wrap style={{ marginTop: t.spacing.md }}>
        {RANGE_OPTIONS.map((opt) => (
          <Chip
            key={opt.value}
            label={opt.label}
            selected={range === opt.value}
            onPress={() => setRange(opt.value)}
          />
        ))}
      </Row>

      {/* Currency switcher — only meaningful when more than one is present. */}
      {currencies.length > 1 ? (
        <Row gap={t.spacing.sm} wrap style={{ marginTop: t.spacing.sm }}>
          {currencies.map((c) => (
            <Chip key={c} label={c} selected={c === cur} onPress={() => setCurrency(c)} />
          ))}
        </Row>
      ) : null}

      {!loaded ? null : !hasData ? (
        <EmptyState
          icon="stats-chart-outline"
          title="No finalized receipts yet"
          message="Scan and finalize receipts and your spend breakdowns — by category, company, payment method and item — will show up here."
        />
      ) : (
        <>
          {/* ---------------------------------------------------------------
              Headline card: total, average, highest, most-frequent vendor.
          --------------------------------------------------------------- */}
          {headline ? (
            <Card style={{ marginTop: t.spacing.lg }}>
              <Text variant="caption" color={t.colors.textMuted}>
                TOTAL SPEND · {headline.count} receipt{headline.count === 1 ? '' : 's'}
              </Text>
              <Text variant="title" color={t.colors.brand}>
                {formatMoney(headline.total, cur)}
              </Text>

              <Divider />

              <Row gap={t.spacing.lg}>
                <View style={{ flex: 1 }}>
                  <Text variant="caption" color={t.colors.textMuted}>AVERAGE</Text>
                  <Text variant="subheading">{formatMoney(headline.average, cur)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="caption" color={t.colors.textMuted}>HIGHEST</Text>
                  {headline.highest ? (
                    <Text variant="subheading">{formatMoney(headline.highest.total, cur)}</Text>
                  ) : (
                    <Text variant="subheading" color={t.colors.textMuted}>—</Text>
                  )}
                </View>
              </Row>

              {headline.highest && headline.highest.vendor ? (
                <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: 4 }}>
                  Highest: {headline.highest.vendor}
                </Text>
              ) : null}
              {headline.mostFrequentVendor ? (
                <Row gap={6} style={{ marginTop: t.spacing.sm }}>
                  <Text variant="caption" color={t.colors.textMuted}>Most visited:</Text>
                  <Text variant="caption" weight="600">
                    {headline.mostFrequentVendor.vendor} ({headline.mostFrequentVendor.count}×)
                  </Text>
                </Row>
              ) : null}
            </Card>
          ) : null}

          {/* Per-currency totals — show ALL currencies so multi-currency users
              see the full picture even while viewing one. */}
          {currencyTotals.length > 1 ? (
            <>
              <SectionHeader title="By currency" />
              <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
                {currencyTotals.map((c, i) => (
                  <View key={c.currency}>
                    {i > 0 ? <Divider spacing={0} /> : null}
                    <Row justify="space-between" style={{ paddingVertical: t.spacing.md }}>
                      <Text weight={c.currency === cur ? '700' : '400'}>{c.currency}</Text>
                      <Text color={t.colors.textMuted}>
                        {c.count} · {formatMoney(c.total, c.currency)}
                      </Text>
                    </Row>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {/* Spend-by-category PIE (donut) chart — visual companion to the bars. */}
          {catRows.some((r) => r.total > 0) ? (
            <>
              <SectionHeader title="Spend by category" />
              <Card>
                <CategoryPie theme={t} currency={cur} rows={catRows} />
              </Card>
            </>
          ) : null}

          {/* Horizontal-bar breakdowns. */}
          <BreakdownCard
            theme={t}
            title="By category"
            currency={cur}
            rows={catRows.map((r) => ({ label: r.categoryName, color: r.color, total: r.total, count: r.count }))}
          />
          {/* By subcategory — only meaningful once the user has subcategories. */}
          {subcategoryRows.some((r) => r.key !== null) ? (
            <BreakdownCard
              theme={t}
              title="By subcategory"
              currency={cur}
              rows={subcategoryRows.map((r) => ({ label: r.label, color: r.color, total: r.total, count: r.count }))}
            />
          ) : null}
          <BreakdownCard
            theme={t}
            title="By company"
            currency={cur}
            rows={companyRows.map((r) => ({ label: r.label, color: r.color, total: r.total, count: r.count }))}
          />
          {/* By account — payment methods (cash, bank, credit card) are accounts. */}
          <BreakdownCard
            theme={t}
            title="By account"
            currency={cur}
            rows={paymentRows.map((r) => ({ label: r.label, color: r.color, total: r.total, count: r.count }))}
          />
          <BreakdownCard
            theme={t}
            title="Top items"
            currency={cur}
            rows={itemRows.map((r) => ({ label: r.label, color: r.color, total: r.total, count: r.count }))}
          />

          {/* Monthly spending — SVG bar chart (replaces the plain-View bars). */}
          <SectionHeader title="Monthly spending" />
          <Card>
            <MonthlyBars theme={t} currency={cur} rows={monthRows} />
          </Card>

          {/* Spending trend over time — SVG line chart. */}
          <SectionHeader title="Spending trend" />
          <Card>
            <TrendLine theme={t} currency={cur} rows={monthRows} />
          </Card>

          {/* Daily spending pattern — SVG bar chart of spend per day. */}
          <SectionHeader title="Daily spending" />
          <Card>
            <DailyBars theme={t} currency={cur} rows={dayRows} />
          </Card>

          {/* Drill-down links to the deeper reports. */}
          <SectionHeader title="Reports" />
          <Row gap={t.spacing.md}>
            <Button
              title="Tax report"
              icon="receipt-outline"
              variant="secondary"
              style={{ flex: 1 }}
              onPress={() => router.push('/tax-report')}
            />
            <Button
              title="Statement match"
              icon="git-compare-outline"
              variant="secondary"
              style={{ flex: 1 }}
              onPress={() => router.push('/statement')}
            />
          </Row>
        </>
      )}

      {/* ---------------------------------------------------------------
          Mileage — rendered independently of receipt data so trips still
          surface for users who only track mileage. Always in the default
          currency (trips have no currency of their own).
      --------------------------------------------------------------- */}
      {loaded && mileage.count > 0 ? (
        <>
          <SectionHeader title="Mileage" />
          <Card>
            <Text variant="caption" color={t.colors.textMuted}>
              {mileage.count} trip{mileage.count === 1 ? '' : 's'} in this range
            </Text>
            <Row gap={t.spacing.lg} style={{ marginTop: t.spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Text variant="caption" color={t.colors.textMuted}>TOTAL MILES</Text>
                <Text variant="subheading">{mileage.miles}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="caption" color={t.colors.textMuted}>DEDUCTION</Text>
                <Text variant="subheading" color={t.colors.brand}>
                  {formatMoney(mileage.amount, settings.default_currency)}
                </Text>
              </View>
            </Row>
            <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: t.spacing.sm }}>
              At the per-mile rate stored on each trip · flows into the tax report and exports.
            </Text>
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// BreakdownCard — a titled card whose rows are horizontal bars sized as a % of
// the group's max value, each prefixed with a category-color dot.
// ---------------------------------------------------------------------------
interface BarRow {
  label: string;
  color: string;
  total: number;
  count: number;
}

function BreakdownCard({
  theme: t,
  title,
  currency,
  rows,
}: {
  theme: Theme;
  title: string;
  currency: string;
  rows: BarRow[];
}) {
  if (!rows.length) return null;
  // Bars scale against the largest total in THIS group so the leader fills 100%.
  const max = Math.max(...rows.map((r) => r.total), 0.01);
  // Cap the list so a long tail doesn't dominate the screen.
  const shown = rows.slice(0, 8);

  return (
    <>
      <SectionHeader title={title} />
      <Card style={{ gap: t.spacing.md }}>
        {shown.map((r, i) => {
          const pct = Math.max(2, Math.round((r.total / max) * 100));
          return (
            <View key={`${r.label}-${i}`}>
              <Row justify="space-between" style={{ marginBottom: 4 }}>
                <Row gap={t.spacing.sm} style={{ flex: 1, marginRight: t.spacing.sm }}>
                  <View
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 5,
                      backgroundColor: r.color || t.colors.brand,
                    }}
                  />
                  <Text numberOfLines={1} style={{ flex: 1 }}>
                    {r.label}
                  </Text>
                </Row>
                <Text weight="600">{formatMoney(r.total, currency)}</Text>
              </Row>
              {/* Track + filled bar (plain Views, width as a percentage). */}
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
                    backgroundColor: r.color || t.colors.brand,
                  }}
                />
              </View>
            </View>
          );
        })}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// CategoryPie — donut of spend by category with a legend. Amounts formatted via
// formatMoney; the donut centre shows the formatted total for the currency.
// ---------------------------------------------------------------------------
function CategoryPie({
  theme: t,
  currency,
  rows,
}: {
  theme: Theme;
  currency: string;
  rows: CategorySpend[];
}) {
  // Top categories as slices; lump the long tail into a single "Other" slice so
  // the donut stays legible. Totals are already currency-sliced by the caller.
  const positive = rows.filter((r) => r.total > 0);
  const top = positive.slice(0, 6);
  const rest = positive.slice(6);
  const slices: PieSlice[] = top.map((r) => ({
    key: r.categoryId ?? r.categoryName,
    label: r.categoryName,
    value: r.total,
    color: r.color || t.colors.brand,
  }));
  if (rest.length) {
    slices.push({
      key: '__other__',
      label: 'Other',
      value: rest.reduce((s, r) => s + r.total, 0),
      color: t.colors.textFaint,
    });
  }
  const total = positive.reduce((s, r) => s + r.total, 0);

  return (
    <Row gap={t.spacing.lg} align="center">
      <PieChart
        slices={slices}
        centerTop="TOTAL"
        centerBottom={formatMoney(total, currency)}
      />
      <View style={{ flex: 1, gap: 8 }}>
        {slices.map((s) => {
          const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
          return (
            <Row key={s.key} gap={t.spacing.sm}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: s.color }} />
              <Text numberOfLines={1} style={{ flex: 1 }}>
                {s.label}
              </Text>
              <Text variant="caption" color={t.colors.textMuted}>
                {pct}%
              </Text>
            </Row>
          );
        })}
      </View>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// MonthlyBars — SVG bar chart, one bar per month (most recent 12).
// ---------------------------------------------------------------------------
function MonthlyBars({
  theme: t,
  currency,
  rows,
}: {
  theme: Theme;
  currency: string;
  rows: MonthlySpend[];
}) {
  if (!rows.length) {
    return (
      <Text variant="caption" color={t.colors.textMuted} align="center">
        No dated receipts in this range.
      </Text>
    );
  }
  const recent = rows.slice(-12);
  const peak = recent.reduce((a, b) => (b.total > a.total ? b : a), recent[0]);
  const data: BarDatum[] = recent.map((r) => ({
    key: r.month,
    label: monthLabel(r.month),
    value: r.total,
  }));
  return (
    <BarChart
      data={data}
      caption="Peak month"
      peakLabel={formatMoney(peak.total, currency)}
      labelEvery={recent.length > 8 ? 2 : 1}
    />
  );
}

// ---------------------------------------------------------------------------
// TrendLine — SVG line chart of the monthly totals over time.
// ---------------------------------------------------------------------------
function TrendLine({
  theme: t,
  currency,
  rows,
}: {
  theme: Theme;
  currency: string;
  rows: MonthlySpend[];
}) {
  if (rows.length < 2) {
    return (
      <Text variant="caption" color={t.colors.textMuted} align="center">
        Need at least two months of dated receipts to chart a trend.
      </Text>
    );
  }
  const recent = rows.slice(-12);
  const latest = recent[recent.length - 1];
  const data: LinePoint[] = recent.map((r) => ({
    key: r.month,
    label: monthLabel(r.month),
    value: r.total,
  }));
  return (
    <LineChart
      data={data}
      caption="Latest month"
      peakLabel={formatMoney(latest.total, currency)}
      labelEvery={recent.length > 8 ? 2 : 1}
    />
  );
}

// ---------------------------------------------------------------------------
// DailyBars — SVG bar chart of spend per day across the selected range (capped
// to the most recent 31 days so the axis stays readable).
// ---------------------------------------------------------------------------
function DailyBars({
  theme: t,
  currency,
  rows,
}: {
  theme: Theme;
  currency: string;
  rows: DailySpend[];
}) {
  if (!rows.length) {
    return (
      <Text variant="caption" color={t.colors.textMuted} align="center">
        No dated receipts in this range.
      </Text>
    );
  }
  const recent = rows.slice(-31);
  const peak = recent.reduce((a, b) => (b.total > a.total ? b : a), recent[0]);
  const data: BarDatum[] = recent.map((r) => ({
    key: r.date,
    label: formatDate(r.date, 'D'),
    value: r.total,
  }));
  return (
    <BarChart
      data={data}
      caption="Busiest day"
      peakLabel={formatMoney(peak.total, currency)}
      labelEvery={recent.length > 12 ? Math.ceil(recent.length / 8) : 1}
    />
  );
}

/** Render a "YYYY-MM" key as a short month label (e.g. "Jun"). */
function monthLabel(month: string): string {
  // formatDate needs a full ISO date; anchor to the 1st of the month.
  return formatDate(`${month}-01`, 'MMM');
}
