/**
 * ReportColumnsScreen — the export column picker (TASK 16).
 *
 * The competitor's exports were rigid; here the user fully controls the CSV/Excel
 * layout: which columns appear, their ORDER (move up/down), whether the report is
 * per-line-item ("Single") or per-receipt ("Group"), and a free-text report
 * header. Everything persists to `settings.report_config` and is read by
 * `src/services/exporters.ts`. A live preview of the resulting header row makes
 * the effect obvious before exporting.
 *
 * Pure config logic (normalize / toggle / reorder / effective columns) lives in
 * src/lib/reportConfig.ts and is unit-tested; this screen is just the editor.
 */
import { useMemo } from 'react';
import { Switch, View } from 'react-native';
import {
  Screen,
  Card,
  Text,
  Row,
  SectionHeader,
  TextField,
  SegmentedControl,
  IconButton,
  Button,
  Divider,
  useTheme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import {
  REPORT_COLUMNS,
  columnHeader,
  effectiveColumns,
  isColumnSelected,
  moveColumnDown,
  moveColumnUp,
  normalizeReportConfig,
  resetReportConfig,
  toggleColumn,
} from '@/lib/reportConfig';
import type { ReportMode } from '@/types';

export default function ReportColumnsScreen() {
  const t = useTheme();
  const { settings, update } = useSettings();

  const config = useMemo(
    () => normalizeReportConfig(settings.report_config),
    [settings.report_config],
  );

  const save = (next = config) => update({ report_config: next });

  // Selected columns in their current order (the reorderable list).
  const selected = config.columns;
  // Unselected columns (offered to add back), in canonical order.
  const unselected = REPORT_COLUMNS.map((c) => c.id).filter(
    (id) => !isColumnSelected(config, id),
  );

  // Preview the actual header row the export will emit, honoring group mode.
  const previewHeaders = effectiveColumns(config).map(columnHeader).join(', ');

  return (
    <Screen scroll edges={['top']}>
      <Text variant="title">Export columns</Text>
      <Text variant="body" color={t.colors.textMuted} style={{ marginTop: 4 }}>
        Choose which columns appear in CSV/Excel exports, reorder them, and set
        how rows are grouped.
      </Text>

      {/* Report mode */}
      <SectionHeader title="Report type" />
      <SegmentedControl<ReportMode>
        value={config.mode}
        onChange={(mode) => save({ ...config, mode })}
        options={[
          { label: 'Single (per item)', value: 'single' },
          { label: 'Group (per receipt)', value: 'group' },
        ]}
      />
      <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: 6 }}>
        {config.mode === 'single'
          ? 'One row per line item — fully itemized.'
          : 'One row per receipt — item/qty/unit columns are omitted.'}
      </Text>

      {/* Report header */}
      <SectionHeader title="Report header" />
      <TextField
        value={config.header}
        onChangeText={(header) => save({ ...config, header })}
        placeholder="e.g. Acme Inc — Q2 Expenses"
      />
      <Text variant="caption" color={t.colors.textMuted}>
        Optional text printed as the first line of the export.
      </Text>

      {/* Selected columns (reorderable) */}
      <SectionHeader title={`Columns shown · ${selected.length}`} />
      <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
        {selected.map((id, i) => (
          <Row
            key={id}
            justify="space-between"
            align="center"
            style={{
              paddingVertical: t.spacing.sm,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: t.colors.border,
            }}
          >
            <Text variant="body" weight="600" style={{ flex: 1 }}>
              {columnHeader(id)}
            </Text>
            <Row gap={2} align="center">
              <IconButton
                icon="chevron-up"
                size={18}
                onPress={() => save(moveColumnUp(config, id))}
                accessibilityLabel={`Move ${columnHeader(id)} up`}
              />
              <IconButton
                icon="chevron-down"
                size={18}
                onPress={() => save(moveColumnDown(config, id))}
                accessibilityLabel={`Move ${columnHeader(id)} down`}
              />
              <Switch
                value
                onValueChange={() => save(toggleColumn(config, id))}
                trackColor={{ true: t.colors.brand }}
              />
            </Row>
          </Row>
        ))}
      </Card>

      {/* Add columns */}
      {unselected.length > 0 ? (
        <>
          <SectionHeader title="Add columns" />
          <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
            {unselected.map((id, i) => (
              <Row
                key={id}
                justify="space-between"
                align="center"
                style={{
                  paddingVertical: t.spacing.sm,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: t.colors.border,
                }}
              >
                <Text variant="body" color={t.colors.textMuted} style={{ flex: 1 }}>
                  {columnHeader(id)}
                </Text>
                <Switch
                  value={false}
                  onValueChange={() => save(toggleColumn(config, id))}
                  trackColor={{ true: t.colors.brand }}
                />
              </Row>
            ))}
          </Card>
        </>
      ) : null}

      {/* Preview + reset */}
      <SectionHeader title="Preview" />
      <Card>
        <Text variant="label" color={t.colors.textMuted}>HEADER ROW</Text>
        <Text variant="body" style={{ marginTop: 6 }}>{previewHeaders}</Text>
      </Card>

      <Divider spacing={t.spacing.xl} />
      <Button
        title="Reset to default columns"
        variant="ghost"
        icon="refresh"
        onPress={() => save(resetReportConfig())}
      />
      <View style={{ height: t.spacing.xl }} />
    </Screen>
  );
}
