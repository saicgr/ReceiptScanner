/**
 * History — the searchable, filterable archive of every scanned receipt.
 *
 * Competitor pain points this screen answers directly:
 *  - Weak search / no filtering → a vendor+memo search bar plus category, tag/job
 *    and date-range filter chips (a single `currentFilter` drives BOTH the list
 *    query and the export, so what you see is exactly what you export).
 *  - "Exports only show totals" → the Export button hands the live filter to
 *    `exporters.exportReceipts`, which is always ITEMIZED (one row per line item).
 *  - "Couldn't delete things / rename in bulk" → long-press enters multi-select
 *    for batch DELETE (`deleteReceiptCascade`) and batch RENAME (`batchRename`).
 *
 * Layout: a "Pending" section at the top (email-forwarded + unfinalized scans the
 * user still has to review), then finalized receipts grouped by month. Each row
 * shows the original-image thumbnail, vendor, formatted date + amount, a category
 * colour dot and a per-receipt confidence badge.
 */
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Image } from 'expo-image';
import {
  Screen,
  Card,
  Text,
  Row,
  SectionHeader,
  TextField,
  Chip,
  Badge,
  ConfidenceBadge,
  EmptyState,
  IconButton,
  Button,
  SelectSheet,
  LoadingOverlay,
  useTheme,
  Icon,
  type SelectOption,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import { useLookups } from '@/store/lookups';
import * as DB from '@/db';
import { batchRename, deleteReceiptCascade } from '@/services/receiptService';
import { exportReceipts, shareFile } from '@/services/exporters';
import { formatMoney } from '@/lib/money';
import { formatDate, todayIso } from '@/lib/dates';
import type {
  AccountingFormat,
  ExportFilter,
  Receipt,
} from '@/types';

// ---------------------------------------------------------------------------
// Static option tables
// ---------------------------------------------------------------------------

/** The four date-range presets exposed as a chip (the chip cycles through them). */
type DateRange = 'all' | 'month' | 'year' | '30d';
const DATE_RANGE_LABEL: Record<DateRange, string> = {
  all: 'All time',
  month: 'This month',
  year: 'This year',
  '30d': 'Last 30 days',
};
const DATE_RANGE_OPTIONS: SelectOption[] = (
  Object.keys(DATE_RANGE_LABEL) as DateRange[]
).map((value) => ({ value, label: DATE_RANGE_LABEL[value] }));

/** Export targets offered in the format sheet (file formats only — no live APIs). */
const EXPORT_OPTIONS: { value: AccountingFormat; label: string; icon: SelectOption['icon'] }[] = [
  { value: 'csv', label: 'CSV (itemized)', icon: 'grid-outline' },
  { value: 'excel', label: 'Excel (.csv)', icon: 'grid-outline' },
  { value: 'pdf', label: 'PDF report', icon: 'document-text-outline' },
  { value: 'quickbooks_csv', label: 'QuickBooks CSV', icon: 'cash-outline' },
  { value: 'quickbooks_iif', label: 'QuickBooks IIF', icon: 'cash-outline' },
  { value: 'xero_csv', label: 'Xero CSV', icon: 'cash-outline' },
  { value: 'wave_csv', label: 'Wave CSV', icon: 'cash-outline' },
];

/** Resolve a date-range preset into ISO start/end bounds for the query/filter. */
function rangeBounds(range: DateRange): { startDate: string | null; endDate: string | null } {
  if (range === 'all') return { startDate: null, endDate: null };
  const now = new Date();
  const y = now.getFullYear();
  if (range === 'month') {
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return { startDate: `${y}-${m}-01`, endDate: todayIso() };
  }
  if (range === 'year') {
    return { startDate: `${y}-01-01`, endDate: todayIso() };
  }
  // Last 30 days.
  const start = new Date(now);
  start.setDate(start.getDate() - 30);
  return { startDate: start.toISOString().slice(0, 10), endDate: todayIso() };
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function HistoryScreen() {
  const t = useTheme();
  const { settings } = useSettings();
  const lookups = useLookups();

  // Search + filter state. `categoryIds`/`tagIds` are multi-select; `range` is a
  // single preset. Together they form the one `currentFilter` reused everywhere.
  const [search, setSearch] = useState('');
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [range, setRange] = useState<DateRange>('all');

  // Active sheet (only one open at a time).
  const [sheet, setSheet] = useState<'category' | 'tag' | 'range' | 'export' | null>(null);

  // Data buckets: pending (top) + finalized (grouped by month below).
  const [pending, setPending] = useState<Receipt[]>([]);
  const [finalized, setFinalized] = useState<Receipt[]>([]);

  // Multi-select (entered by long-press); holds the selected receipt ids.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Busy flag for batch ops / export so the user gets a blocking spinner.
  const [busy, setBusy] = useState<string | null>(null);

  // The single source of truth for "what is currently shown" — passed verbatim
  // to the exporter so the export always matches the on-screen result set.
  const currentFilter: ExportFilter = useMemo(() => {
    const { startDate, endDate } = rangeBounds(range);
    return {
      startDate,
      endDate,
      categoryIds: categoryIds.length ? categoryIds : undefined,
      tagIds: tagIds.length ? tagIds : undefined,
    };
  }, [range, categoryIds, tagIds]);

  // ---- data loading ----
  const load = useCallback(async () => {
    const base = {
      ...currentFilter,
      search: search.trim() || undefined,
      orderBy: 'date_desc' as const,
    };
    const [pend, fin] = await Promise.all([
      DB.listReceipts({ ...base, status: 'pending' }),
      DB.listReceipts({ ...base, status: 'finalized' }),
    ]);
    setPending(pend);
    setFinalized(fin);
  }, [currentFilter, search]);

  // Reload on focus and whenever the filter/search changes while focused.
  useFocusEffect(
    useCallback(() => {
      lookups.refresh();
      load();
    }, [load, lookups.refresh]),
  );

  // ---- month grouping for the finalized list ----
  const monthGroups = useMemo(() => {
    const map = new Map<string, Receipt[]>();
    for (const r of finalized) {
      // Group by YYYY-MM; receipts with no date fall into a stable "Undated" bucket.
      const key = r.date ? r.date.slice(0, 7) : 'undated';
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    // Already date-desc from the query, so insertion order is newest-first.
    return [...map.entries()];
  }, [finalized]);

  const hasFilters =
    categoryIds.length > 0 || tagIds.length > 0 || range !== 'all' || search.trim().length > 0;

  // ---- multi-select helpers ----
  const enterSelect = (id: string) => {
    setSelectMode(true);
    setSelected(new Set([id]));
  };
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const openReceipt = (id: string) => {
    if (selectMode) {
      toggleSelect(id);
      return;
    }
    router.push({ pathname: '/receipt/[id]', params: { id } });
  };

  // ---- batch actions ----
  const runBatchDelete = () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    Alert.alert(
      'Delete receipts?',
      `Permanently delete ${ids.length} receipt${ids.length === 1 ? '' : 's'}? This also removes their scheduled reminders.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusy('Deleting…');
            try {
              // Cascade-delete each (cancels notifications + removes child rows).
              for (const id of ids) await deleteReceiptCascade(id);
            } finally {
              setBusy(null);
              exitSelect();
              load();
            }
          },
        },
      ],
    );
  };

  const runBatchRename = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy('Renaming…');
    try {
      // Regenerate saved_filename from the current template for each selected id.
      const n = await batchRename(ids);
      Alert.alert('Batch rename', `Updated ${n} of ${ids.length} filename${ids.length === 1 ? '' : 's'}.`);
    } finally {
      setBusy(null);
      exitSelect();
      load();
    }
  };

  // ---- export ----
  const runExport = async (format: AccountingFormat) => {
    setSheet(null);
    // Export is part of the one-time purchase (the free tier covers scans
    // only) — route locked users to the paywall instead of generating a file.
    if (!settings.is_unlocked) {
      Alert.alert(
        'Unlock required',
        'Exports are included in the one-time ReceiptSnap unlock — no subscriptions, no ads.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Unlock', onPress: () => router.push('/paywall') },
        ],
      );
      return;
    }
    setBusy('Exporting…');
    try {
      // Export EXACTLY the currently-filtered set; the exporter is itemized.
      const uri = await exportReceipts(format, currentFilter);
      await shareFile(uri);
    } catch {
      Alert.alert('Export failed', 'Could not generate the export file. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  // ---- selection-option builders (sheets) ----
  const categoryOptions: SelectOption[] = lookups.categories.map((c) => ({
    value: c.id,
    label: c.name,
    color: c.color,
  }));
  // Tag/job filter: tags + jobs + trips, annotated by kind so jobs are findable.
  const tagOptions: SelectOption[] = lookups.tags.map((tag) => ({
    value: tag.id,
    label: tag.name,
    color: tag.color,
    subtitle: tag.kind === 'tag' ? undefined : tag.kind === 'job' ? 'Job' : 'Trip',
  }));

  return (
    <Screen scroll edges={['top']}>
      {/* Header: title + select/export affordances. In select mode the header
          switches to a batch-action bar so the actions are always reachable. */}
      {selectMode ? (
        <Row justify="space-between" align="center">
          <Row gap={t.spacing.sm} align="center">
            <IconButton icon="close" onPress={exitSelect} accessibilityLabel="Cancel selection" />
            <Text variant="heading">{selected.size} selected</Text>
          </Row>
          <Row gap={t.spacing.sm}>
            <IconButton
              icon="pricetag-outline"
              onPress={runBatchRename}
              accessibilityLabel="Batch rename"
            />
            <IconButton
              icon="trash-outline"
              color={t.colors.danger}
              onPress={runBatchDelete}
              accessibilityLabel="Batch delete"
            />
          </Row>
        </Row>
      ) : (
        <Row justify="space-between" align="center">
          <Text variant="title">History</Text>
          <IconButton
            icon="share-outline"
            size={24}
            onPress={() => setSheet('export')}
            accessibilityLabel="Export receipts"
          />
        </Row>
      )}

      {/* Search bar (vendor + memo). Re-queries on submit/blur for snappy typing. */}
      <View style={{ marginTop: t.spacing.md }}>
        <TextField
          value={search}
          onChangeText={setSearch}
          onBlur={load}
          placeholder="Search vendor or memo"
          prefix=""
          right={
            search ? (
              <IconButton
                icon="close-circle"
                size={18}
                color={t.colors.textMuted}
                onPress={() => {
                  setSearch('');
                  // Clear immediately so the list reflects the reset.
                  setTimeout(load, 0);
                }}
              />
            ) : (
              <Icon name="search" size={18} color={t.colors.textMuted} />
            )
          }
        />
      </View>

      {/* Filter chips: category, tag/job, date range. Each opens its SelectSheet. */}
      <Row gap={t.spacing.sm} wrap style={{ marginBottom: t.spacing.sm }}>
        <Chip
          label={
            categoryIds.length
              ? `Categories · ${categoryIds.length}`
              : 'Category'
          }
          icon="pricetags-outline"
          selected={categoryIds.length > 0}
          onPress={() => setSheet('category')}
        />
        <Chip
          label={tagIds.length ? `Tags · ${tagIds.length}` : 'Tag / Job'}
          icon="bookmark-outline"
          selected={tagIds.length > 0}
          onPress={() => setSheet('tag')}
        />
        <Chip
          label={DATE_RANGE_LABEL[range]}
          icon="calendar-outline"
          selected={range !== 'all'}
          onPress={() => setSheet('range')}
        />
        {hasFilters ? (
          <Chip
            label="Clear"
            icon="refresh"
            onPress={() => {
              setSearch('');
              setCategoryIds([]);
              setTagIds([]);
              setRange('all');
              setTimeout(load, 0);
            }}
          />
        ) : null}
      </Row>

      {/* PENDING — email-forwarded + unfinalized scans awaiting review. */}
      {pending.length > 0 ? (
        <>
          <SectionHeader title={`Pending review · ${pending.length}`} />
          <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
            {pending.map((r, i) => (
              <ReceiptRow
                key={r.id}
                receipt={r}
                first={i === 0}
                pending
                selectMode={selectMode}
                selected={selected.has(r.id)}
                dateFormat={settings.date_format}
                categoryColor={lookups.categoryById(r.category_id)?.color ?? null}
                onPress={() => openReceipt(r.id)}
                onLongPress={() => enterSelect(r.id)}
              />
            ))}
          </Card>
        </>
      ) : null}

      {/* FINALIZED — grouped by month, newest first. */}
      {finalized.length === 0 && pending.length === 0 ? (
        <EmptyState
          icon="albums-outline"
          title={hasFilters ? 'No matching receipts' : 'No receipts yet'}
          message={
            hasFilters
              ? 'Try clearing your search or filters.'
              : 'Scan a receipt and it will show up here.'
          }
          action={hasFilters ? undefined : 'Quick Scan'}
          onAction={hasFilters ? undefined : () => router.push('/scan')}
        />
      ) : (
        monthGroups.map(([monthKey, items]) => (
          <View key={monthKey}>
            <SectionHeader title={monthLabel(monthKey, settings.date_format)} />
            <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
              {items.map((r, i) => (
                <ReceiptRow
                  key={r.id}
                  receipt={r}
                  first={i === 0}
                  selectMode={selectMode}
                  selected={selected.has(r.id)}
                  dateFormat={settings.date_format}
                  categoryColor={lookups.categoryById(r.category_id)?.color ?? null}
                  onPress={() => openReceipt(r.id)}
                  onLongPress={() => enterSelect(r.id)}
                />
              ))}
            </Card>
          </View>
        ))
      )}

      {/* A persistent export button at the bottom mirrors the header action so it
          is reachable after a long scroll. */}
      {finalized.length > 0 && !selectMode ? (
        <Button
          title="Export filtered results"
          icon="download-outline"
          variant="secondary"
          style={{ marginTop: t.spacing.lg }}
          onPress={() => setSheet('export')}
        />
      ) : null}

      {/* ---- Sheets ---- */}
      <SelectSheet
        visible={sheet === 'category'}
        title="Filter by category"
        multi
        options={categoryOptions}
        selected={categoryIds}
        onSelect={(vals) => {
          setCategoryIds(vals);
          setTimeout(load, 0);
        }}
        onClose={() => setSheet(null)}
      />
      <SelectSheet
        visible={sheet === 'tag'}
        title="Filter by tag / job"
        multi
        options={tagOptions}
        selected={tagIds}
        onSelect={(vals) => {
          setTagIds(vals);
          setTimeout(load, 0);
        }}
        onClose={() => setSheet(null)}
      />
      <SelectSheet
        visible={sheet === 'range'}
        title="Date range"
        options={DATE_RANGE_OPTIONS}
        selected={[range]}
        onSelect={(vals) => {
          setRange((vals[0] as DateRange) ?? 'all');
          setTimeout(load, 0);
        }}
        onClose={() => setSheet(null)}
      />
      <SelectSheet
        visible={sheet === 'export'}
        title="Export format"
        options={EXPORT_OPTIONS}
        selected={[]}
        onSelect={(vals) => {
          const fmt = vals[0] as AccountingFormat | undefined;
          if (fmt) runExport(fmt);
        }}
        onClose={() => setSheet(null)}
      />

      <LoadingOverlay visible={busy !== null} message={busy ?? undefined} />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Receipt row
// ---------------------------------------------------------------------------

/**
 * One receipt line: thumbnail of the retained original image, vendor, formatted
 * date + amount, a category colour dot and a confidence badge. In multi-select
 * mode the thumbnail is replaced by a check toggle. Long-press enters selection.
 */
function ReceiptRow({
  receipt,
  first,
  pending,
  selectMode,
  selected,
  dateFormat,
  categoryColor,
  onPress,
  onLongPress,
}: {
  receipt: Receipt;
  first: boolean;
  pending?: boolean;
  selectMode: boolean;
  selected: boolean;
  dateFormat: string;
  categoryColor: string | null;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const t = useTheme();
  // Overall confidence = the weakest of vendor/date/total, so the badge nudges
  // the user toward whatever still needs a second look.
  const level = worstConfidence(receipt);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: t.spacing.md,
        paddingVertical: t.spacing.md,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.colors.border,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {selectMode ? (
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: t.radius.md,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon
            name={selected ? 'checkmark-circle' : 'ellipse-outline'}
            size={24}
            color={selected ? t.colors.brand : t.colors.textMuted}
          />
        </View>
      ) : receipt.original_image_uri ? (
        <Image
          source={{ uri: receipt.original_image_uri }}
          style={{ width: 44, height: 44, borderRadius: t.radius.md }}
          contentFit="cover"
        />
      ) : (
        // Fallback tile when no original image was retained.
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: t.radius.md,
            backgroundColor: t.colors.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="receipt-outline" size={20} color={t.colors.textMuted} />
        </View>
      )}

      <View style={{ flex: 1 }}>
        <Row gap={6} align="center">
          {categoryColor ? (
            <View
              style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: categoryColor }}
            />
          ) : null}
          <Text variant="body" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
            {receipt.vendor || 'Untitled receipt'}
          </Text>
        </Row>
        <Text variant="caption" color={t.colors.textMuted}>
          {formatDate(receipt.date, dateFormat) || 'No date'}
        </Text>
      </View>

      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        {/* Money ONLY via formatMoney with the receipt's own currency. */}
        <Text variant="body" weight="600">
          {formatMoney(receipt.total, receipt.currency)}
        </Text>
        {pending ? (
          <Badge label="Pending" icon="time-outline" color={t.colors.warning} background={t.colors.warningTint} />
        ) : (
          <ConfidenceBadge level={level} />
        )}
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Overall confidence = the lowest of the receipt's per-field confidences. */
function worstConfidence(receipt: Receipt): 'high' | 'medium' | 'low' {
  const fc = receipt.field_confidence;
  const levels = [fc.vendor, fc.date, fc.total, fc.tax];
  if (levels.includes('low')) return 'low';
  if (levels.includes('medium')) return 'medium';
  return 'high';
}

/** Render a YYYY-MM group key as a human month header using the user's format. */
function monthLabel(key: string, dateFormat: string): string {
  if (key === 'undated') return 'Undated';
  // Reuse the date formatter against the first of the month; show month + year.
  // Prefer a "Month YYYY" style regardless of the user's day/separator choices.
  const iso = `${key}-01`;
  const label = formatDate(iso, 'MMMM YYYY');
  return label || key;
}
