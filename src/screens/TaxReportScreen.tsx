/**
 * TaxReportScreen — Schedule-C style tax-deduction report (item 9 in the
 * SCREENS contract).
 *
 * The user picks a tax YEAR (the common case) or a custom date RANGE, and we run
 * `taxReportService.buildTaxReport` to aggregate every finalized receipt, manual
 * cash expense and mileage trip in that window. Results are grouped by tax
 * category AND currency, so a multi-currency user never sees mismatched sums
 * lumped together; mileage appears as its own fully-deductible line.
 *
 * For each group we show gross + deductible totals, plus a per-currency total
 * footer (the figure that actually flows onto a Schedule C). The whole report can
 * be exported to CSV or PDF via `exporters.exportTaxReport`, then handed to the OS
 * share sheet.
 *
 * Nothing here mutates data — it is a pure read/aggregate/export view.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import {
  Button,
  Card,
  Chip,
  ConfidenceBadge,
  Divider,
  EmptyState,
  IconButton,
  LoadingOverlay,
  Row,
  Screen,
  SectionHeader,
  SegmentedControl,
  Spacer,
  Text,
  TextField,
  useTheme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import { buildTaxReport } from '@/services/taxReportService';
import { exportTaxReport, shareFile } from '@/services/exporters';
import { formatMoney } from '@/lib/money';
import { formatDate, isValidIso, taxYearBounds, todayIso } from '@/lib/dates';
import type { TaxReportRow } from '@/types';

/** Date-range selection mode. */
type RangeMode = 'year' | 'custom';

/** A currency's gross + deductible roll-up, derived from the report rows. */
interface CurrencySummary {
  currency: string;
  gross: number;
  deductible: number;
  count: number;
}

export default function TaxReportScreen() {
  const t = useTheme();
  const { settings } = useSettings();
  const dateFmt = settings.date_format;

  // --- Range selection state ---
  const currentYear = useMemo(() => {
    const p = todayIso().slice(0, 4);
    const n = Number(p);
    return Number.isFinite(n) ? n : new Date().getFullYear();
  }, []);

  const [mode, setMode] = useState<RangeMode>('year');
  const [year, setYear] = useState<number>(currentYear);
  // Custom range fields are raw ISO strings the user edits directly.
  const [customStart, setCustomStart] = useState<string>(`${currentYear}-01-01`);
  const [customEnd, setCustomEnd] = useState<string>(todayIso());

  // --- Report state ---
  const [rows, setRows] = useState<TaxReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Resolve the effective start/end ISO bounds for the active mode. */
  const bounds = useMemo<{ startDate: string; endDate: string } | null>(() => {
    if (mode === 'year') {
      const { start, end } = taxYearBounds(year);
      return { startDate: start, endDate: end };
    }
    // Custom: only valid when both dates parse and start <= end.
    if (!isValidIso(customStart) || !isValidIso(customEnd)) return null;
    if (customStart > customEnd) return null;
    return { startDate: customStart, endDate: customEnd };
  }, [mode, year, customStart, customEnd]);

  /** (Re)build the report for the current bounds. */
  const reload = useCallback(async () => {
    if (!bounds) {
      setRows([]);
      setError('Enter a valid date range (YYYY-MM-DD), with the start on or before the end.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await buildTaxReport(bounds);
      setRows(result);
    } catch {
      setRows([]);
      setError('Could not build the tax report. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [bounds]);

  // Rebuild whenever the effective range changes (year switch, custom edits,
  // mode toggle). Custom-mode edits debounce naturally via the dependency on the
  // memoized `bounds`, which only changes when a valid range is produced.
  useEffect(() => {
    void reload();
  }, [reload]);

  // --- Derived: per-currency roll-up for the totals footer ---
  const currencySummaries = useMemo<CurrencySummary[]>(() => {
    const byCurrency = new Map<string, CurrencySummary>();
    for (const r of rows) {
      const s =
        byCurrency.get(r.currency) ??
        { currency: r.currency, gross: 0, deductible: 0, count: 0 };
      s.gross += r.grossTotal;
      s.deductible += r.deductibleTotal;
      s.count += r.count;
      byCurrency.set(r.currency, s);
    }
    return Array.from(byCurrency.values()).sort((a, b) =>
      a.currency.localeCompare(b.currency),
    );
  }, [rows]);

  // Group the rows by currency so the table reads as one section per currency.
  const sections = useMemo<{ currency: string; rows: TaxReportRow[] }[]>(() => {
    const byCurrency = new Map<string, TaxReportRow[]>();
    for (const r of rows) {
      const list = byCurrency.get(r.currency) ?? [];
      list.push(r);
      byCurrency.set(r.currency, list);
    }
    return Array.from(byCurrency.entries())
      .map(([currency, list]) => ({ currency, rows: list }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }, [rows]);

  // --- Export ---
  const onExport = useCallback(
    async (format: 'csv' | 'pdf') => {
      if (!bounds || rows.length === 0) return;
      setExporting(true);
      try {
        // The exporter labels the file by year; for a custom range we pass the
        // start year as the best single-year label.
        const labelYear = mode === 'year' ? year : Number(bounds.startDate.slice(0, 4));
        const uri = await exportTaxReport(rows, { year: labelYear, format });
        await shareFile(uri);
      } catch {
        setError('Export failed. Please try again.');
      } finally {
        setExporting(false);
      }
    },
    [bounds, rows, mode, year],
  );

  // Years offered as quick-pick chips: current year and the prior four.
  const yearChips = useMemo(
    () => [0, 1, 2, 3, 4].map((delta) => currentYear - delta),
    [currentYear],
  );

  const hasData = rows.length > 0;

  return (
    <Screen scroll>
      <Row justify="space-between">
        <Text variant="title">Tax Report</Text>
        <ConfidenceBadge level="medium" />
      </Row>
      <Text variant="body" color={t.colors.textMuted}>
        Schedule-C style summary of deductible spending, grouped by tax category and
        currency. Includes finalized receipts, manual cash expenses and mileage.
      </Text>

      {/* ---- Range picker ---- */}
      <Spacer size={t.spacing.lg} />
      <Card>
        <SegmentedControl<RangeMode>
          value={mode}
          onChange={setMode}
          options={[
            { label: 'Tax Year', value: 'year' },
            { label: 'Custom Range', value: 'custom' },
          ]}
        />

        {mode === 'year' ? (
          <>
            <Spacer size={t.spacing.md} />
            <Row gap={t.spacing.sm} wrap>
              {yearChips.map((y) => (
                <Chip
                  key={y}
                  label={String(y)}
                  selected={y === year}
                  onPress={() => setYear(y)}
                />
              ))}
            </Row>
            <Spacer size={t.spacing.sm} />
            <Text variant="caption" color={t.colors.textMuted}>
              {`Jan 1 – Dec 31, ${year}`}
            </Text>
          </>
        ) : (
          <>
            <Spacer size={t.spacing.md} />
            <TextField
              label="Start date (YYYY-MM-DD)"
              value={customStart}
              onChangeText={setCustomStart}
              placeholder="2026-01-01"
              keyboardType="numbers-and-punctuation"
            />
            <TextField
              label="End date (YYYY-MM-DD)"
              value={customEnd}
              onChangeText={setCustomEnd}
              placeholder="2026-12-31"
              keyboardType="numbers-and-punctuation"
            />
            {bounds ? (
              <Text variant="caption" color={t.colors.textMuted}>
                {`${formatDate(bounds.startDate, dateFmt)} – ${formatDate(bounds.endDate, dateFmt)}`}
              </Text>
            ) : (
              <Text variant="caption" color={t.colors.danger}>
                Enter a valid start and end date (start on or before end).
              </Text>
            )}
          </>
        )}
      </Card>

      {/* ---- Error banner ---- */}
      {error ? (
        <>
          <Spacer size={t.spacing.md} />
          <Card style={{ borderColor: t.colors.danger, backgroundColor: t.colors.dangerTint }}>
            <Row gap={t.spacing.sm} align="flex-start">
              <IconButton icon="alert-circle" color={t.colors.danger} onPress={() => void reload()} />
              <Text variant="body" color={t.colors.danger} style={{ flex: 1 }}>
                {error}
              </Text>
            </Row>
          </Card>
        </>
      ) : null}

      {/* ---- Per-currency totals (the headline figures) ---- */}
      {hasData ? (
        <>
          <SectionHeader title="Deductible Summary" />
          {currencySummaries.map((s) => (
            <Card key={s.currency} style={{ marginBottom: t.spacing.sm }}>
              <Row justify="space-between" align="flex-start">
                <View style={{ flex: 1 }}>
                  <Text variant="subheading">{s.currency}</Text>
                  <Text variant="caption" color={t.colors.textMuted}>
                    {`${s.count} record${s.count === 1 ? '' : 's'} · gross ${formatMoney(
                      s.gross,
                      s.currency,
                    )}`}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text variant="heading" color={t.colors.brand}>
                    {formatMoney(s.deductible, s.currency)}
                  </Text>
                  <Text variant="caption" color={t.colors.textMuted}>
                    deductible
                  </Text>
                </View>
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      {/* ---- Itemized breakdown by tax category ---- */}
      {hasData ? (
        sections.map((section) => (
          <View key={section.currency}>
            <SectionHeader title={`Breakdown · ${section.currency}`} />
            <Card padded={false}>
              {/* Column header */}
              <Row
                style={{
                  paddingHorizontal: t.spacing.lg,
                  paddingVertical: t.spacing.sm,
                }}
              >
                <Text variant="caption" color={t.colors.textMuted} style={{ flex: 1 }}>
                  TAX CATEGORY
                </Text>
                <Text
                  variant="caption"
                  color={t.colors.textMuted}
                  align="right"
                  style={{ width: 90 }}
                >
                  GROSS
                </Text>
                <Text
                  variant="caption"
                  color={t.colors.textMuted}
                  align="right"
                  style={{ width: 90 }}
                >
                  DEDUCT.
                </Text>
              </Row>
              <Divider spacing={0} />
              {section.rows.map((r, idx) => (
                <View key={`${r.taxCategoryId ?? 'none'}-${r.currency}`}>
                  <Row
                    align="flex-start"
                    style={{
                      paddingHorizontal: t.spacing.lg,
                      paddingVertical: t.spacing.md,
                    }}
                  >
                    <View style={{ flex: 1, paddingRight: t.spacing.sm }}>
                      <Text variant="body" weight="500">
                        {r.taxCategoryName}
                      </Text>
                      <Text variant="caption" color={t.colors.textMuted}>
                        {`${r.deductiblePercent}% · ${r.count} record${
                          r.count === 1 ? '' : 's'
                        }`}
                      </Text>
                    </View>
                    <Text variant="body" align="right" style={{ width: 90 }}>
                      {formatMoney(r.grossTotal, r.currency)}
                    </Text>
                    <Text
                      variant="body"
                      align="right"
                      color={t.colors.brand}
                      weight="600"
                      style={{ width: 90 }}
                    >
                      {formatMoney(r.deductibleTotal, r.currency)}
                    </Text>
                  </Row>
                  {idx < section.rows.length - 1 ? <Divider spacing={0} /> : null}
                </View>
              ))}
            </Card>
          </View>
        ))
      ) : !loading && !error ? (
        <>
          <Spacer size={t.spacing.xl} />
          <EmptyState
            icon="receipt-outline"
            title="No deductible activity"
            message={
              mode === 'year'
                ? `No finalized receipts, cash expenses or mileage trips found in ${year}. Finalize some receipts and assign tax categories to see them here.`
                : 'No finalized receipts, cash expenses or mileage trips found in this range. Assign tax categories on the review screen to populate this report.'
            }
          />
        </>
      ) : null}

      {/* ---- Export actions ---- */}
      {hasData ? (
        <>
          <SectionHeader title="Export" />
          <Row gap={t.spacing.md}>
            <Button
              title="Export CSV"
              icon="document-text-outline"
              variant="secondary"
              onPress={() => void onExport('csv')}
              style={{ flex: 1 }}
            />
            <Button
              title="Export PDF"
              icon="document-outline"
              variant="primary"
              onPress={() => void onExport('pdf')}
              style={{ flex: 1 }}
            />
          </Row>
          <Spacer size={t.spacing.sm} />
          <Text variant="caption" color={t.colors.textMuted} align="center">
            The actual deductible amount uses each record&apos;s own deductible
            percentage, which you can override per receipt on the review screen.
          </Text>
        </>
      ) : null}

      <LoadingOverlay visible={loading} message="Building tax report…" />
      <LoadingOverlay visible={exporting} message="Preparing export…" />
    </Screen>
  );
}
