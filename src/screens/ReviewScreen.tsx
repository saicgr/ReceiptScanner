/**
 * Review — THE core screen, and the one that fixes every accuracy complaint the
 * competitor shipped. The whole receipt is an editable working copy held in the
 * draft store: EVERY field can be corrected, line items can be added/edited/
 * deleted/unticked, and the total recalculates live from the included items.
 *
 * Competitor gaps explicitly solved here:
 *  - Poor accuracy + no way to fix it      → every field editable + confidence badges.
 *  - Ambiguous dates                        → interpretation chips when date_ambiguous.
 *  - Can't delete / untick line items       → delete + include checkbox, total recalcs.
 *  - Can't see the full original image       → "View full original" → image viewer.
 *  - Exports only show totals                → itemized model edited right here.
 * Plus V2: warranty/return windows, per-item serial + product photo, and tax
 * deductibility. Nothing is ever auto-finalized — the user taps Save.
 */
import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, View, ScrollView, Text as RNText } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  Card,
  Button,
  Text,
  Row,
  SectionHeader,
  TextField,
  MoneyInput,
  Chip,
  Stepper,
  SelectSheet,
  ConfidenceBadge,
  Badge,
  GradientHero,
  IconButton,
  Icon,
  Divider,
  Spacer,
  LoadingOverlay,
  useTheme,
  type IconName,
  type SelectOption,
} from '@/components/ui';
import { fonts } from '@/theme';
import { useDraft, draftDeadlines, type DraftLineItem } from '@/store/draft';
import { useSettings } from '@/store/settings';
import { useLookups } from '@/store/lookups';
import { persistDraft } from '@/services/receiptService';
import { pickFromGallery } from '@/services/imagePipeline';
import { formatMoney, parseMoney, lineTotal } from '@/lib/money';
import { formatDate, deadlineFrom } from '@/lib/dates';

/** Which SelectSheet (if any) is currently open. The line-item category sheet
 *  carries the target item id so we know where to write the chosen category. */
type Sheet =
  | { kind: 'none' }
  | { kind: 'currency' }
  | { kind: 'category' }
  | { kind: 'payment' }
  | { kind: 'tax_category' }
  | { kind: 'tags' }
  | { kind: 'date' }
  | { kind: 'item_category'; itemId: string };

const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR', 'MYR', 'SGD', 'CHF'];

export default function ReviewScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { settings } = useSettings();
  const lookups = useLookups();

  // Subscribe to the WHOLE draft so any field/line-item change re-renders and the
  // subtotal/total recompute live (the headline competitor fix).
  const d = useDraft();
  const {
    setField,
    addLineItem,
    updateLineItem,
    deleteLineItem,
    toggleIncluded,
    chooseDate,
    patch,
  } = d;

  const [sheet, setSheet] = useState<Sheet>({ kind: 'none' });
  const [saving, setSaving] = useState(false);

  // Ensure lookups are present (categories/tax cats/payment/tags) for the pickers.
  useFocusEffect(
    useCallback(() => {
      if (!lookups.loaded) lookups.refresh();
    }, [lookups.loaded]), // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- Live-derived values ---------------------------------------------------
  const hasItems = d.lineItems.length > 0;
  const subtotal = d.subtotal();
  const total = d.total();
  // Receipt-level protection deadlines, previewed from window/period + date.
  const deadlines = useMemo(() => draftDeadlines(d), [d]);

  // Has the extractor effectively returned nothing useful? Used for a gentle hint
  // — we NEVER render a literal "not found" placeholder anywhere.
  const looksEmpty =
    !d.vendor.trim() && !d.date && !hasItems && d.manual_total === 0;

  // Pre-select the suggested tax category by NAME-matching the lookups, but only
  // when the user hasn't already chosen one. Runs once when lookups are ready.
  useFocusEffect(
    useCallback(() => {
      if (d.tax_category_id || !d.suggested_tax_category || !lookups.loaded) return;
      const match = lookups.taxCategories.find(
        (tc) => tc.name.toLowerCase() === d.suggested_tax_category!.toLowerCase(),
      );
      if (match) {
        patch({
          tax_category_id: match.id,
          is_deductible: true,
          deductible_percent: match.deductible_percent,
        });
      }
    }, [d.tax_category_id, d.suggested_tax_category, lookups.loaded]), // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Pre-select the suggested SPENDING category by name (user can override). The
  // suggestion is non-binding: we only fill an empty category.
  useFocusEffect(
    useCallback(() => {
      if (d.category_id || !d.suggested_category || !lookups.loaded) return;
      const match = lookups.categories.find(
        (c) => c.name.toLowerCase() === d.suggested_category!.toLowerCase(),
      );
      if (match) setField('category_id', match.id);
    }, [d.category_id, d.suggested_category, lookups.loaded]), // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- Picker option lists ---------------------------------------------------
  const categoryOptions: SelectOption[] = lookups.categories.map((c) => ({
    label: c.name,
    value: c.id,
    color: c.color,
  }));
  const paymentOptions: SelectOption[] = lookups.paymentMethods.map((p) => ({
    label: p.name,
    value: p.id,
    icon: 'card-outline',
  }));
  const taxCategoryOptions: SelectOption[] = lookups.taxCategories.map((tc) => ({
    label: tc.name,
    value: tc.id,
    subtitle: `${tc.deductible_percent}% deductible`,
    icon: 'pricetag-outline',
  }));
  const tagOptions: SelectOption[] = lookups.tags.map((tg) => ({
    label: tg.name,
    value: tg.id,
    color: tg.color,
    subtitle: tg.kind !== 'tag' ? tg.kind : undefined,
  }));
  const currencyOptions: SelectOption[] = COMMON_CURRENCIES.map((c) => ({
    label: c,
    value: c,
  }));

  const category = lookups.categoryById(d.category_id);
  const payment = lookups.paymentById(d.payment_method_id);
  const taxCategory = lookups.taxCategoryById(d.tax_category_id);

  // ---- Save ------------------------------------------------------------------
  const onSave = async () => {
    if (d.date_ambiguous) {
      Alert.alert('Pick a date', 'This date is ambiguous — choose the correct interpretation first.');
      return;
    }
    setSaving(true);
    try {
      await persistDraft({ finalize: true });
      // Leave the review flow: dismiss any modal stack, else fall back to tabs.
      if (router.dismissAll) router.dismissAll();
      else router.replace('/(tabs)');
    } catch (e) {
      setSaving(false);
      Alert.alert('Could not save', e instanceof Error ? e.message : 'Please try again.');
    }
  };

  const onDiscard = () =>
    Alert.alert('Discard this receipt?', 'Your edits will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => { useDraft.getState().reset(); router.back(); } },
    ]);

  const openOriginal = () => {
    const uris = d.imageUris.length ? d.imageUris : d.original_image_uri ? [d.original_image_uri] : [];
    if (uris.length === 0) {
      Alert.alert('No image', 'This receipt has no stored image (it may have come in by email).');
      return;
    }
    router.push({ pathname: '/image-viewer', params: { uris: JSON.stringify(uris) } });
  };

  const heroTotal = hasItems ? total : d.manual_total;

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
      >
        {/* ---------------- HERO: live, editable headline ---------------- */}
        <GradientHero style={{ paddingTop: insets.top + 12, paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xl }}>
          <Row justify="space-between" align="center" style={{ marginBottom: t.spacing.xl }}>
            <Pressable
              onPress={onDiscard}
              accessibilityLabel="Discard"
              hitSlop={8}
              style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', opacity: pressed ? 0.7 : 1 })}
            >
              <Ionicons name="close" size={20} color={t.colors.onHero} />
            </Pressable>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 }}>
              <Ionicons name={d.status === 'finalized' ? 'checkmark-done' : 'time-outline'} size={13} color={t.colors.onHero} />
              <RNText style={{ color: t.colors.onHero, fontFamily: fonts.sansBold, fontSize: 12 }}>{d.status === 'finalized' ? 'Saved' : 'Pending'}</RNText>
            </View>
          </Row>

          <RNText style={{ color: t.colors.onHeroMuted, fontFamily: fonts.sansBold, fontSize: 11.5, letterSpacing: 2.4 }}>REVIEW</RNText>
          <RNText style={{ color: t.colors.onHero, fontFamily: fonts.display, fontSize: 28, letterSpacing: -0.5, marginTop: 6 }} numberOfLines={1}>
            {d.vendor.trim() || 'New receipt'}
          </RNText>
          <RNText style={{ color: t.colors.onHero, fontFamily: fonts.displayMedium, fontSize: 46, letterSpacing: -1.1, marginTop: 12 }}>
            {formatMoney(heroTotal, d.currency)}
          </RNText>
          <RNText style={{ color: t.colors.onHeroMuted, fontFamily: fonts.sansSemibold, fontSize: 12.5, marginTop: 8 }}>
            {hasItems ? 'Total auto-calculated from items below' : 'Nothing is saved until you tap Save'}
          </RNText>
        </GradientHero>

        <View style={{ paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.md }}>
      {/* Detected condition attributes (torn/folded/faded…). Tap to remove. */}
      {d.condition_tags.length > 0 ? (
        <Row gap={6} wrap style={{ marginTop: t.spacing.sm }}>
          {d.condition_tags.map((c) => (
            <Chip
              key={c}
              label={c}
              selected
              icon="pricetag-outline"
              onRemove={() =>
                setField(
                  'condition_tags',
                  d.condition_tags.filter((x) => x !== c),
                )
              }
            />
          ))}
        </Row>
      ) : null}

      {/* Gentle hint when extraction produced almost nothing — never "not found". */}
      {looksEmpty ? (
        <Card style={{ marginTop: t.spacing.md, backgroundColor: t.colors.infoTint, borderColor: t.colors.info }}>
          <Row gap={t.spacing.sm} align="flex-start">
            <Icon name="information-circle" color={t.colors.info} />
            <Text variant="body" color={t.colors.text} style={{ flex: 1 }}>
              We couldn't read much from this scan. Fill in the vendor, date and total
              below — you can still add line items by hand.
            </Text>
          </Row>
        </Card>
      ) : null}

      {/* Duplicate warning — link straight to the suspected original. */}
      {d.duplicateOfId ? (
        <Card style={{ marginTop: t.spacing.md, backgroundColor: t.colors.warningTint, borderColor: t.colors.warning }}>
          <Row gap={t.spacing.sm} align="flex-start">
            <Icon name="copy" color={t.colors.warning} />
            <View style={{ flex: 1 }}>
              <Text variant="label" color={t.colors.text}>Possible duplicate</Text>
              <Text variant="caption" color={t.colors.textMuted}>
                {Math.round(d.duplicateScore * 100)}% similar to a receipt you already scanned.
              </Text>
              <Spacer size={6} />
              <Button
                title="View the existing one"
                variant="ghost"
                size="sm"
                icon="open-outline"
                onPress={() =>
                  router.push({ pathname: '/receipt/[id]', params: { id: d.duplicateOfId! } })
                }
              />
            </View>
          </Row>
        </Card>
      ) : null}

      {/* Original image access — the user can ALWAYS open the full scan. */}
      <Button
        title="View full original"
        variant="secondary"
        icon="image-outline"
        style={{ marginTop: t.spacing.lg }}
        onPress={openOriginal}
      />

      {/* ------------------------------------------------------------------ */}
      {/* Header fields                                                       */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeader title="Details" />
      <Card>
        <TextField
          label="Vendor"
          value={d.vendor}
          onChangeText={(v) => setField('vendor', v)}
          placeholder="Who did you pay?"
          confidence={d.field_confidence.vendor}
        />

        {/* DATE — ambiguous dates become chips the user must pick from. */}
        <DateField
          ambiguous={d.date_ambiguous}
          date={d.date}
          options={d.date_options}
          confidence={d.field_confidence.date}
          dateFormat={settings.date_format}
          onPick={chooseDate}
          onOpenSheet={() => setSheet({ kind: 'date' })}
          onChangeRaw={(v) => setField('date', v || null)}
        />

        {/* Currency picker — money is ALWAYS shown via formatMoney with this. */}
        <PickerRow
          label="Currency"
          value={d.currency}
          onPress={() => setSheet({ kind: 'currency' })}
        />
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Line items — editable, deletable, untickable; total recalcs live.  */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeader
        title="Line items"
        action="Add item"
        actionIcon="add"
        onAction={() => addLineItem()}
      />
      {hasItems ? (
        <Card padded={false} style={{ paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm }}>
          {d.lineItems.map((li, i) => (
            <View key={li.id}>
              {i > 0 ? <Divider spacing={t.spacing.sm} /> : null}
              <LineItemRow
                item={li}
                currency={d.currency}
                categoryLabel={lookups.categoryById(li.category_id)?.name ?? null}
                categoryColor={lookups.categoryById(li.category_id)?.color}
                onToggle={() => toggleIncluded(li.id)}
                onDelete={() => deleteLineItem(li.id)}
                onName={(v) => updateLineItem(li.id, { name: v })}
                onQty={(v) => updateLineItem(li.id, { qty: v })}
                onPrice={(v) => updateLineItem(li.id, { price: v ?? 0 })}
                onSerial={(v) => updateLineItem(li.id, { serial_number: v || null })}
                onPickPhoto={async () => {
                  const [uri] = await pickFromGallery();
                  if (uri) updateLineItem(li.id, { product_photo_uri: uri });
                }}
                onSplitCategory={() => setSheet({ kind: 'item_category', itemId: li.id })}
              />
            </View>
          ))}
        </Card>
      ) : (
        <Card>
          <Text variant="body" color={t.colors.textMuted}>
            No itemized lines. Add items for an itemized export, or just enter the
            total below.
          </Text>
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Totals — when items exist the total is DERIVED (auto from items).  */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeader title="Totals" />
      <Card>
        <Row justify="space-between">
          <Text variant="body" color={t.colors.textMuted}>Subtotal (included items)</Text>
          <Text variant="body" weight="600">{formatMoney(subtotal, d.currency)}</Text>
        </Row>
        <Spacer size={t.spacing.md} />

        {/* MoneyInput keeps the raw text while typing ("3.50" stays "3.50") and
            commits the parsed number on blur. Clearing the field means "no tax". */}
        <MoneyInput
          label="Tax"
          value={d.tax}
          zeroAsEmpty={false}
          onCommit={(v) => setField('tax', v)}
          placeholder="0.00"
          confidence={d.field_confidence.tax}
          prefix={d.currency}
        />

        {hasItems ? (
          <View>
            <Row justify="space-between" align="center">
              <Text variant="label" color={t.colors.textMuted}>TOTAL</Text>
              <Badge label="auto from items" icon="calculator-outline" color={t.colors.brand} background={t.colors.brandTint} />
            </Row>
            <Text variant="heading" style={{ marginTop: 6 }}>{formatMoney(total, d.currency)}</Text>
            <Text variant="caption" color={t.colors.textMuted}>
              Recalculated live as you edit, untick or delete items.
            </Text>
          </View>
        ) : (
          <MoneyInput
            label="Total"
            value={d.manual_total}
            onCommit={(v) => setField('manual_total', v ?? 0)}
            placeholder="0.00"
            confidence={d.field_confidence.total}
            prefix={d.currency}
          />
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Organization — category / payment / tags / memo                    */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeader title="Organize" />
      <Card>
        <PickerRow
          label="Category"
          value={category?.name ?? 'Uncategorized'}
          color={category?.color}
          onPress={() => setSheet({ kind: 'category' })}
        />
        <Divider spacing={t.spacing.sm} />
        <PickerRow
          label="Payment method"
          value={payment?.name ?? 'Not set'}
          onPress={() => setSheet({ kind: 'payment' })}
        />
        <Divider spacing={t.spacing.sm} />

        {/* Tags (trip / job grouping) — multi-select rendered as chips. */}
        <View style={{ paddingVertical: t.spacing.sm }}>
          <Row justify="space-between" align="center">
            <Text variant="label" color={t.colors.textMuted}>Tags / jobs</Text>
            <IconButton icon="add-circle-outline" onPress={() => setSheet({ kind: 'tags' })} />
          </Row>
          {d.tagIds.length === 0 ? (
            <Text variant="caption" color={t.colors.textMuted}>None — tap + to group by trip or job.</Text>
          ) : (
            <Row gap={t.spacing.sm} wrap style={{ marginTop: 6 }}>
              {d.tagIds.map((id) => {
                const tg = lookups.tagById(id);
                if (!tg) return null;
                return (
                  <Chip
                    key={id}
                    label={tg.name}
                    color={tg.color}
                    selected
                    onRemove={() => setField('tagIds', d.tagIds.filter((x) => x !== id))}
                  />
                );
              })}
            </Row>
          )}
        </View>
        <Divider spacing={t.spacing.sm} />

        <TextField
          label="Memo / description"
          value={d.memo}
          onChangeText={(v) => setField('memo', v)}
          placeholder="Note what this was for (included in exports)"
          multiline
          style={{ marginBottom: 0 }}
        />
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Tax intelligence (V2)                                               */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeader title="Tax" />
      <Card>
        <PickerRow
          label="Tax category"
          value={taxCategory?.name ?? 'None'}
          onPress={() => setSheet({ kind: 'tax_category' })}
        />
        <Divider spacing={t.spacing.sm} />
        <Row justify="space-between" align="center" style={{ paddingVertical: t.spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Text variant="body">Tax deductible</Text>
            <Text variant="caption" color={t.colors.textMuted}>Counts toward your tax report.</Text>
          </View>
          <Chip
            label={d.is_deductible ? 'Deductible' : 'Not deductible'}
            icon={d.is_deductible ? 'checkmark-circle' : 'close-circle'}
            selected={d.is_deductible}
            onPress={() => setField('is_deductible', !d.is_deductible)}
          />
        </Row>
        {d.is_deductible ? (
          <MoneyInput
            label="Deductible percent"
            value={d.deductible_percent}
            zeroAsEmpty={false}
            onCommit={(v) => setField('deductible_percent', Math.max(0, Math.min(100, v ?? 0)))}
            keyboardType="number-pad"
            prefix="%"
            style={{ marginTop: t.spacing.sm, marginBottom: 0 }}
          />
        ) : null}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Protection windows (V2) — return + warranty, with deadline preview. */}
      {/* ------------------------------------------------------------------ */}
      <SectionHeader title="Protection" />
      <Card>
        <Text variant="caption" color={t.colors.textMuted} style={{ marginBottom: t.spacing.sm }}>
          Track return windows and warranties — we'll remind you before they lapse.
        </Text>
        <Row gap={t.spacing.md} align="flex-start">
          <View style={{ flex: 1 }}>
            <TextField
              label="Return window (days)"
              value={d.return_window_days == null ? '' : String(d.return_window_days)}
              onChangeText={(v) => setField('return_window_days', v.trim() === '' ? null : Math.round(parseMoney(v)))}
              keyboardType="number-pad"
              placeholder="—"
              style={{ marginBottom: 4 }}
            />
            <DeadlinePreview label="Return by" iso={deadlines.return_deadline} dateFormat={settings.date_format} color={t.colors.warning} />
          </View>
          <View style={{ flex: 1 }}>
            <TextField
              label="Warranty (days)"
              value={d.warranty_period_days == null ? '' : String(d.warranty_period_days)}
              onChangeText={(v) => setField('warranty_period_days', v.trim() === '' ? null : Math.round(parseMoney(v)))}
              keyboardType="number-pad"
              placeholder="—"
              style={{ marginBottom: 4 }}
            />
            <DeadlinePreview label="Covered until" iso={deadlines.warranty_deadline} dateFormat={settings.date_format} color={t.colors.info} />
          </View>
        </Row>
      </Card>

      {/* Save — the only thing that finalizes the receipt. */}
      <Spacer size={t.spacing.xl} />
      <Button title="Save receipt" icon="checkmark" size="lg" onPress={onSave} />
      <Spacer size={t.spacing.md} />
      <Button title="Discard" variant="ghost" onPress={onDiscard} />
        </View>
      </ScrollView>

      {/* ------------------------------------------------------------------ */}
      {/* SelectSheets (one mounted instance, switched by `sheet.kind`)       */}
      {/* ------------------------------------------------------------------ */}
      <SelectSheet
        visible={sheet.kind === 'currency'}
        title="Currency"
        options={currencyOptions}
        selected={[d.currency]}
        onClose={() => setSheet({ kind: 'none' })}
        onSelect={([v]) => v && setField('currency', v)}
      />
      <SelectSheet
        visible={sheet.kind === 'category'}
        title="Category"
        options={categoryOptions}
        selected={d.category_id ? [d.category_id] : []}
        onClose={() => setSheet({ kind: 'none' })}
        onSelect={([v]) => setField('category_id', v ?? null)}
      />
      <SelectSheet
        visible={sheet.kind === 'payment'}
        title="Payment method"
        options={paymentOptions}
        selected={d.payment_method_id ? [d.payment_method_id] : []}
        onClose={() => setSheet({ kind: 'none' })}
        onSelect={([v]) => setField('payment_method_id', v ?? null)}
      />
      <SelectSheet
        visible={sheet.kind === 'tax_category'}
        title="Tax category"
        options={taxCategoryOptions}
        selected={d.tax_category_id ? [d.tax_category_id] : []}
        onClose={() => setSheet({ kind: 'none' })}
        onSelect={([v]) => {
          // Choosing a tax category prefills deductibility from its default %.
          const tc = lookups.taxCategoryById(v ?? null);
          patch({
            tax_category_id: v ?? null,
            is_deductible: tc ? true : d.is_deductible,
            deductible_percent: tc ? tc.deductible_percent : d.deductible_percent,
          });
        }}
      />
      <SelectSheet
        visible={sheet.kind === 'tags'}
        title="Tags / jobs"
        options={tagOptions}
        selected={d.tagIds}
        multi
        onClose={() => setSheet({ kind: 'none' })}
        onSelect={(vals) => setField('tagIds', vals)}
      />
      {/* Date interpretation picker (used when not rendered inline as chips). */}
      <SelectSheet
        visible={sheet.kind === 'date'}
        title="Choose the date"
        options={(d.date_options.length ? d.date_options : d.date ? [d.date] : []).map((iso) => ({
          label: formatDate(iso, settings.date_format),
          value: iso,
          subtitle: iso,
          icon: 'calendar-outline',
        }))}
        selected={d.date ? [d.date] : []}
        onClose={() => setSheet({ kind: 'none' })}
        onSelect={([v]) => v && chooseDate(v)}
      />
      {/* Split-transaction: per-item category. */}
      <SelectSheet
        visible={sheet.kind === 'item_category'}
        title="Item category (split)"
        options={[{ label: 'Use receipt category', value: '' }, ...categoryOptions]}
        selected={
          sheet.kind === 'item_category'
            ? [d.lineItems.find((li) => li.id === sheet.itemId)?.category_id ?? '']
            : []
        }
        onClose={() => setSheet({ kind: 'none' })}
        onSelect={([v]) => {
          if (sheet.kind === 'item_category') {
            updateLineItem(sheet.itemId, { category_id: v ? v : null });
          }
        }}
      />

      <LoadingOverlay visible={saving} message="Saving receipt…" />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Date field — chips when ambiguous (the explicit disambiguation fix), else a
// formatted, editable raw field with a tap-to-pick from the known options.
// ---------------------------------------------------------------------------
function DateField({
  ambiguous,
  date,
  options,
  confidence,
  dateFormat,
  onPick,
  onOpenSheet,
  onChangeRaw,
}: {
  ambiguous: boolean;
  date: string | null;
  options: string[];
  confidence: 'high' | 'medium' | 'low';
  dateFormat: string;
  onPick: (iso: string) => void;
  onOpenSheet: () => void;
  onChangeRaw: (v: string) => void;
}) {
  const t = useTheme();
  if (ambiguous && options.length > 1) {
    return (
      <View style={{ marginBottom: t.spacing.md }}>
        <Row justify="space-between" align="center" style={{ marginBottom: 6 }}>
          <Text variant="label" color={t.colors.textMuted}>Date — which did you mean?</Text>
          <ConfidenceBadge level={confidence} />
        </Row>
        <Text variant="caption" color={t.colors.textMuted} style={{ marginBottom: t.spacing.sm }}>
          This date could be read more than one way — tap the correct one.
        </Text>
        <Row gap={t.spacing.sm} wrap>
          {options.map((iso) => (
            <Chip
              key={iso}
              label={formatDate(iso, dateFormat)}
              icon="calendar-outline"
              selected={date === iso}
              onPress={() => onPick(iso)}
            />
          ))}
        </Row>
      </View>
    );
  }
  // Unambiguous: an editable raw ISO field, plus a button to pick from options.
  return (
    <TextField
      label="Date"
      value={date ?? ''}
      onChangeText={onChangeRaw}
      placeholder="YYYY-MM-DD"
      confidence={confidence}
      right={
        <IconButton
          icon="calendar-outline"
          onPress={onOpenSheet}
          accessibilityLabel="Pick from detected dates"
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// PickerRow — a tappable "label → value (chevron)" row that opens a SelectSheet.
// ---------------------------------------------------------------------------
function PickerRow({
  label,
  value,
  color,
  onPress,
}: {
  label: string;
  value: string;
  color?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: t.spacing.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text variant="label" color={t.colors.textMuted}>{label}</Text>
      <Row gap={t.spacing.sm} style={{ alignItems: 'center' }}>
        {color ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: color }} /> : null}
        <Text variant="body" weight="500">{value}</Text>
        <Icon name="chevron-down" size={16} color={t.colors.textMuted} />
      </Row>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// DeadlinePreview — tiny computed-deadline label under the window/period fields.
// ---------------------------------------------------------------------------
function DeadlinePreview({
  label,
  iso,
  dateFormat,
  color,
}: {
  label: string;
  iso: string | null;
  dateFormat: string;
  color: string;
}) {
  const t = useTheme();
  if (!iso) {
    return (
      <Text variant="caption" color={t.colors.textMuted}>
        Set a date + days to preview the deadline.
      </Text>
    );
  }
  return (
    <Badge label={`${label} ${formatDate(iso, dateFormat)}`} icon="alarm-outline" color={color} background={color + '22'} />
  );
}

// ---------------------------------------------------------------------------
// LineItemRow — name + qty (Stepper) + price + include checkbox + delete, plus
// the V2 split category / serial number / product photo controls. The include
// checkbox drives live total recalculation.
// ---------------------------------------------------------------------------
function LineItemRow({
  item,
  currency,
  categoryLabel,
  categoryColor,
  onToggle,
  onDelete,
  onName,
  onQty,
  onPrice,
  onSerial,
  onPickPhoto,
  onSplitCategory,
}: {
  item: DraftLineItem;
  currency: string;
  categoryLabel: string | null;
  categoryColor?: string;
  onToggle: () => void;
  onDelete: () => void;
  onName: (v: string) => void;
  onQty: (v: number) => void;
  onPrice: (v: number | null) => void;
  onSerial: (v: string) => void;
  onPickPhoto: () => void;
  onSplitCategory: () => void;
}) {
  const t = useTheme();
  const [expanded, setExpanded] = useState(false);
  const lt = lineTotal(item.qty, item.price);
  return (
    <View style={{ opacity: item.included ? 1 : 0.5, paddingVertical: t.spacing.xs }}>
      <Row gap={t.spacing.sm} align="center">
        {/* Include checkbox — unticking removes the item from the live total. */}
        <IconButton
          icon={item.included ? 'checkbox' : 'square-outline'}
          color={item.included ? t.colors.brand : t.colors.textMuted}
          onPress={onToggle}
          accessibilityLabel={item.included ? 'Exclude from total' : 'Include in total'}
        />
        <View style={{ flex: 1 }}>
          <TextField
            value={item.name}
            onChangeText={onName}
            placeholder="Item name"
            style={{ marginBottom: 0 }}
          />
        </View>
        <IconButton icon="trash-outline" color={t.colors.danger} onPress={onDelete} accessibilityLabel="Delete item" />
      </Row>

      <Row gap={t.spacing.sm} align="center" style={{ marginTop: t.spacing.sm }}>
        <Stepper value={item.qty} onChange={onQty} min={0} />
        <View style={{ flex: 1 }}>
          {/* Raw text kept while typing; the parsed price commits on blur, which
              re-runs the live total recalculation. A price of 0 shows as empty. */}
          <MoneyInput
            value={item.price}
            onCommit={onPrice}
            placeholder="0.00"
            prefix={currency}
            style={{ marginBottom: 0 }}
          />
        </View>
        <Text variant="body" weight="600">{formatMoney(lt, currency)}</Text>
      </Row>

      {/* More: split category, serial number, product photo (V2). */}
      <Row justify="space-between" align="center" style={{ marginTop: t.spacing.xs }}>
        <Chip
          label={categoryLabel ?? 'Split category'}
          icon="git-branch-outline"
          color={categoryColor}
          selected={!!categoryLabel}
          onPress={onSplitCategory}
        />
        <IconButton
          icon={expanded ? 'chevron-up' : 'chevron-down'}
          onPress={() => setExpanded((e) => !e)}
          accessibilityLabel="More item details"
        />
      </Row>

      {expanded ? (
        <View style={{ marginTop: t.spacing.sm }}>
          <TextField
            label="Serial number"
            value={item.serial_number ?? ''}
            onChangeText={onSerial}
            placeholder="For warranty claims"
            style={{ marginBottom: t.spacing.sm }}
          />
          <Row gap={t.spacing.sm} align="center">
            <Button
              title={item.product_photo_uri ? 'Replace product photo' : 'Add product photo'}
              variant="secondary"
              size="sm"
              icon="camera-outline"
              onPress={onPickPhoto}
            />
            {item.product_photo_uri ? (
              <Badge label="Photo attached" icon="checkmark-circle" color={t.colors.success} background={t.colors.successTint} />
            ) : null}
          </Row>
        </View>
      ) : null}
    </View>
  );
}
