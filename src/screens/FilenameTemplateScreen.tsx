/**
 * FilenameTemplateScreen — the explicit "control the saved filename" demand the
 * competitor ignored ("not being able to control the saved filename").
 *
 * The user edits `settings.filename_template` directly: tap a token chip to
 * append it, clear the whole template, and watch a live preview built from a
 * realistic sample receipt via `applyFilenameTemplate`. We validate as they type
 * (`validateTemplate`) and warn loudly when an unknown token slips in so they
 * never produce a broken name. The chosen image format (jpg/png) is shown so the
 * preview reflects the real on-disk filename, and a one-tap "Batch-rename" action
 * re-applies the template to every existing receipt — the missing feature users
 * complained about most.
 *
 * Everything persists through `useSettings().update`, the single source of truth
 * the rest of the pipeline (`receiptService.persistDraft`) reads when saving.
 */
import { useState } from 'react';
import { Alert, View } from 'react-native';
import {
  Screen,
  Card,
  Button,
  Text,
  Row,
  SectionHeader,
  Chip,
  SegmentedControl,
  TextField,
  Badge,
  Divider,
  useTheme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import * as DB from '@/db';
import { batchRename } from '@/services/receiptService';
import {
  FILENAME_TOKENS,
  applyFilenameTemplate,
  validateTemplate,
  type FilenameContext,
} from '@/lib/filename';
import type { ImageFormat } from '@/types';

/**
 * A realistic sample receipt so the preview shows exactly what a real save
 * produces — Whole Foods, $42.50 USD, a stable id, today's date.
 */
const SAMPLE_CTX: FilenameContext = {
  date: '2026-06-04',
  vendor: 'Whole Foods',
  total: 42.5,
  currency: 'USD',
  categoryName: 'Groceries',
  paymentName: 'Credit card',
  tax: 3.4,
  id: '8f3a1c92-0000-0000-0000-000000000000',
  createdAt: '2026-06-04T14:30:05.000Z',
};

export default function FilenameTemplateScreen() {
  const t = useTheme();
  const { settings, update } = useSettings();

  // Local working copy of the template so typing/appending feels instant; we
  // persist on every change (cheap key/value write) like the other settings.
  const [template, setTemplate] = useState(settings.filename_template);
  const [renaming, setRenaming] = useState(false);

  // Live validation + preview. Unknown tokens are surfaced as a warning banner.
  const { ok, unknownTokens } = validateTemplate(template);
  const preview = `${applyFilenameTemplate(template, SAMPLE_CTX, settings.date_format)}.${settings.image_format}`;

  /** Commit a template change to local state + persisted settings. */
  const commitTemplate = (next: string) => {
    setTemplate(next);
    update({ filename_template: next });
  };

  /** Append a token to the end of the current template. */
  const appendToken = (token: string) => commitTemplate(template + token);

  /** Clear the template entirely (the preview falls back to a safe default). */
  const clearTemplate = () => commitTemplate('');

  /** Persist the chosen image format so saved files carry the right extension. */
  const setImageFormat = (fmt: ImageFormat) => update({ image_format: fmt });

  /** Re-apply the current template to every existing receipt on disk. */
  const batchRenameAll = async () => {
    setRenaming(true);
    try {
      // Collect every receipt id regardless of pending/finalized status.
      const all = await DB.listReceipts({ status: 'all' });
      const count = await batchRename(all.map((r) => r.id));
      Alert.alert(
        'Batch rename complete',
        count === 0
          ? 'All receipts were already up to date.'
          : `Renamed ${count} receipt${count === 1 ? '' : 's'} to match the current template.`,
      );
    } catch {
      Alert.alert('Batch rename', 'Something went wrong while renaming. Please try again.');
    } finally {
      setRenaming(false);
    }
  };

  return (
    <Screen scroll edges={['top']}>
      <Text variant="title">Filename Template</Text>
      <Text variant="body" color={t.colors.textMuted} style={{ marginTop: 4 }}>
        Control exactly how every saved scan is named. Tap tokens to build the
        pattern; it applies automatically to new scans.
      </Text>

      {/* Live preview of the resulting on-disk filename. */}
      <Card style={{ marginTop: t.spacing.lg }}>
        <Text variant="label" color={t.colors.textMuted}>
          PREVIEW
        </Text>
        <Text variant="subheading" weight="600" style={{ marginTop: 6 }} numberOfLines={2}>
          {preview}
        </Text>
        <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: 4 }}>
          Sample: Whole Foods · $42.50 · 4 Jun 2026
        </Text>
      </Card>

      {/* The editable template string itself. */}
      <SectionHeader title="Template" />
      <TextField
        value={template}
        onChangeText={commitTemplate}
        placeholder="{date}_{company}_{amount}"
        confidence={ok ? undefined : 'low'}
      />
      {!ok ? (
        <Card style={{ borderColor: t.colors.danger, marginBottom: t.spacing.md }}>
          <Row gap={t.spacing.sm} align="flex-start">
            <Badge label="Unknown" icon="alert-circle" color={t.colors.danger} background={t.colors.dangerTint} />
            <Text variant="body" color={t.colors.danger} style={{ flex: 1 }}>
              These tokens aren&apos;t recognized and will be left as literal text:{' '}
              {unknownTokens.join(', ')}
            </Text>
          </Row>
        </Card>
      ) : null}
      <Button title="Clear template" variant="ghost" icon="trash-outline" size="sm" onPress={clearTemplate} />

      {/* Tappable token chips that append to the template. */}
      <SectionHeader title="Available tokens" />
      <Row gap={t.spacing.sm} wrap>
        {FILENAME_TOKENS.map((token) => (
          <Chip key={token} label={token} icon="add" onPress={() => appendToken(token)} />
        ))}
      </Row>

      {/* Image format — drives the extension shown in the preview + on disk. */}
      <SectionHeader title="Image format" />
      <SegmentedControl<ImageFormat>
        value={settings.image_format}
        onChange={setImageFormat}
        options={[
          { label: 'JPG', value: 'jpg' },
          { label: 'PNG', value: 'png' },
        ]}
      />

      <Divider spacing={t.spacing.xl} />

      {/* Apply the template retroactively to the whole library. */}
      <View style={{ gap: t.spacing.sm }}>
        <Button
          title="Batch-rename all existing receipts"
          icon="sync-outline"
          variant="secondary"
          loading={renaming}
          onPress={batchRenameAll}
        />
        <Text variant="caption" color={t.colors.textMuted}>
          Re-saves every stored receipt image under the current template — handy
          after you change the pattern.
        </Text>
      </View>
    </Screen>
  );
}
