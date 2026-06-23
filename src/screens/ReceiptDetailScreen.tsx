/**
 * Receipt detail — the read-only summary of a single finalized/pending receipt,
 * rebuilt in the VAULT language: a full-bleed emerald hero leads with the vendor
 * and total, then editable-looking field cards, the itemized line list, an
 * emerald money-summary, the retained ORIGINAL image (tap → full-screen/share),
 * protection deadlines, tags and a memo. Share + delete live in the hero; Edit
 * hydrates the draft and jumps to Review. All data/actions are unchanged.
 */
import { useCallback, useState } from 'react';
import { Alert, Linking, Platform, Pressable, View, ScrollView, Text as RNText } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams, Stack } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import {
  Screen,
  Button,
  Text,
  Row,
  Chip,
  Badge,
  EmptyState,
  GradientHero,
  IconButton,
  LoadingOverlay,
  useTheme,
  type IconName,
} from '@/components/ui';
import { fonts } from '@/theme';
import { useSettings } from '@/store/settings';
import { useLookups } from '@/store/lookups';
import { useDraft } from '@/store/draft';
import { FolderPickerSheet } from '@/components/FolderPickerSheet';
import { AddProtectionSheet, type ProtectionKind } from '@/components/AddProtectionSheet';
import * as DB from '@/db';
import { decodeSnapshot } from '@/db/revisions';
import { deleteReceiptCascade, revertToSnapshot } from '@/services/receiptService';
import { shareWarrantyClaim } from '@/services/warrantyClaimService';
import { findMatchesForReceipt, dismissMatch } from '@/services/recallService';
import { cardBenefitHints } from '@/lib/cardBenefits';
import { formatMoney } from '@/lib/money';
import { formatDate, relativeDays } from '@/lib/dates';
import { hasValidCoords, formatCoords, mapsUrl } from '@/lib/maps';
import type {
  AuditLogEntry,
  Folder,
  PriceProtection,
  Rebate,
  ReceiptRevision,
  ReceiptWithRelations,
  RecallMatch,
} from '@/types';

function urgencyColor(iso: string, theme: ReturnType<typeof useTheme>) {
  const days = Math.round(
    (Date.parse(iso) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000,
  );
  if (days < 0) return theme.colors.textMuted;
  if (days <= 3) return theme.colors.danger;
  if (days <= 14) return theme.colors.warning;
  return theme.colors.success;
}

const CONF = {
  high: { label: 'High confidence', icon: 'checkmark-circle' as IconName },
  medium: { label: 'Check fields', icon: 'alert-circle' as IconName },
  low: { label: 'Verify fields', icon: 'help-circle' as IconName },
};
function worstConfidence(fc: ReceiptWithRelations['field_confidence']): 'high' | 'medium' | 'low' {
  const levels = [fc.vendor, fc.date, fc.total, fc.tax];
  if (levels.includes('low')) return 'low';
  if (levels.includes('medium')) return 'medium';
  return 'high';
}

export default function ReceiptDetailScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { settings } = useSettings();
  const lookups = useLookups();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [receipt, setReceipt] = useState<ReceiptWithRelations | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [revisions, setRevisions] = useState<ReceiptRevision[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [recalls, setRecalls] = useState<RecallMatch[]>([]);
  const [rebates, setRebates] = useState<Rebate[]>([]);
  const [priceProtections, setPriceProtections] = useState<PriceProtection[]>([]);
  const [protectionSheet, setProtectionSheet] = useState<ProtectionKind | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      setLoaded(true);
      return;
    }
    const [r, fs, revs, log, rbs, pps] = await Promise.all([
      DB.getReceipt(id),
      DB.Folders.foldersForReceipt(id),
      DB.Revisions.listRevisions(id),
      DB.Revisions.listAuditLog(id),
      DB.Rebates.listRebatesForReceipt(id),
      DB.PriceProtections.listPriceProtectionsForReceipt(id),
    ]);
    setReceipt(r);
    setFolders(fs);
    setRevisions(revs);
    setAuditLog(log);
    setRebates(rbs);
    setPriceProtections(pps);
    setLoaded(true);
    // Recall check is best-effort and reads the local cache only (no fetch here).
    findMatchesForReceipt(id)
      .then(setRecalls)
      .catch(() => setRecalls([]));
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loaded && !receipt) {
    return (
      <Screen scroll edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <Row align="center" gap={t.spacing.sm} style={{ marginBottom: t.spacing.md }}>
          <IconButton icon="chevron-back" size={24} onPress={() => router.back()} accessibilityLabel="Back" />
          <Text variant="title">Receipt</Text>
        </Row>
        <EmptyState icon="alert-circle-outline" title="Receipt not found" message="It may have been deleted." action="Back to history" onAction={() => router.back()} />
      </Screen>
    );
  }
  if (!receipt) {
    return <Screen><LoadingOverlay visible message="Loading…" /></Screen>;
  }

  const r = receipt;
  const category = lookups.categoryById(r.category_id);
  const payment = lookups.paymentById(r.payment_method_id);
  const taxCategory = lookups.taxCategoryById(r.tax_category_id);
  const conf = CONF[worstConfidence(r.field_confidence)];

  const pageUris = r.images.map((img) => img.uri);
  const primaryUri = pageUris[0] ?? r.original_image_uri;
  const viewerUris = pageUris.length > 0 ? pageUris : r.original_image_uri ? [r.original_image_uri] : [];

  const onEdit = () => {
    useDraft.getState().startFromReceipt(r);
    router.push('/review');
  };
  const onShareOriginal = async () => {
    const uri = r.original_image_uri ?? primaryUri;
    if (!uri) { Alert.alert('Share', 'No image is attached to this receipt.'); return; }
    try {
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
      else Alert.alert('Share', 'Sharing is not available on this device.');
    } catch { Alert.alert('Share', 'Could not share the image.'); }
  };
  const onDelete = () => {
    Alert.alert('Delete receipt?', `${r.vendor || 'This receipt'} will be permanently removed. This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { setBusy(true); try { await deleteReceiptCascade(r.id); router.back(); } finally { setBusy(false); } } },
    ]);
  };
  const openViewer = (index: number) => {
    if (viewerUris.length === 0) return;
    router.push({ pathname: '/image-viewer', params: { uris: JSON.stringify(viewerUris), index: String(index) } });
  };

  const onSetFolders = async (folderIds: string[]) => {
    setFolderPickerOpen(false);
    await DB.Folders.setReceiptFolders(r.id, folderIds);
    load();
  };

  const original = revisions.find((rev) => rev.kind === 'original') ?? null;
  const onRevert = () => {
    if (!original) return;
    const snapshot = decodeSnapshot(original);
    if (!snapshot) {
      Alert.alert('Revert', 'The original snapshot could not be read.');
      return;
    }
    Alert.alert(
      'Revert to original?',
      "This restores the AI's original extraction (vendor, date, total, tax, line items). Your edits are replaced; the original image and folders are kept.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revert',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await revertToSnapshot(r.id, snapshot);
              await load();
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const hasProtections = !!(r.return_deadline || r.warranty_deadline);

  // TASK 77 — credit-card protection hints keyed on the payment method.
  const benefitHints = cardBenefitHints(payment?.name ?? null);

  // TASK 80 — bundle serial/photo + receipt into a shareable claim packet.
  const onWarrantyClaim = async () => {
    setBusy(true);
    try {
      await shareWarrantyClaim(r.id);
    } catch {
      Alert.alert('Warranty claim', 'Could not prepare the claim packet.');
    } finally {
      setBusy(false);
    }
  };

  // TASK 78 — dismiss a recall match so it stops surfacing for this receipt.
  const onDismissRecall = (m: RecallMatch) => {
    dismissMatch(r.id, m.recall.recall_id)
      .then(() => setRecalls((prev) => prev.filter((x) => x.recall.recall_id !== m.recall.recall_id)))
      .catch(() => {});
  };
  const onOpenRecall = async (m: RecallMatch) => {
    if (!m.recall.url) return;
    try {
      await Linking.openURL(m.recall.url);
    } catch {
      Alert.alert('Recall', 'Could not open the recall page.');
    }
  };

  // TASK 47 — open the capture location in the device's native maps app.
  const hasLocation = hasValidCoords(r.captured_lat, r.captured_lng);
  const onOpenInMaps = async () => {
    if (!hasLocation) return;
    const url = mapsUrl(
      { lat: r.captured_lat!, lng: r.captured_lng! },
      Platform.OS,
      r.vendor || null,
    );
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Open in Maps', 'Could not open a maps app on this device.');
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}>
        {/* ---------------- HERO ---------------- */}
        <GradientHero style={{ paddingTop: insets.top + 12, paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xl }}>
          <Row justify="space-between" align="center" style={{ marginBottom: t.spacing.xl }}>
            <HeroCircle icon="chevron-back" onPress={() => router.back()} label="Back" />
            <Row gap={t.spacing.sm}>
              {r.status === 'pending' ? (
                <View style={{ backgroundColor: 'rgba(243,226,176,0.92)', paddingVertical: 6, paddingHorizontal: 11, borderRadius: 999, alignSelf: 'center' }}>
                  <RNText style={{ color: '#08311F', fontFamily: fonts.sansBold, fontSize: 12 }}>Pending</RNText>
                </View>
              ) : null}
              <HeroCircle icon="qr-code-outline" onPress={() => router.push({ pathname: '/share-qr', params: { id: r.id } })} label="Share via QR" />
              <HeroCircle icon="share-outline" onPress={onShareOriginal} label="Share original image" />
              <HeroCircle icon="trash-outline" onPress={onDelete} label="Delete receipt" />
            </Row>
          </Row>

          <RNText style={{ color: t.colors.onHero, fontFamily: fonts.display, fontSize: 30, letterSpacing: -0.6 }}>
            {r.vendor || 'Untitled receipt'}
          </RNText>
          <Row gap={10} align="center" style={{ marginTop: 8 }}>
            <RNText style={{ color: t.colors.onHeroMuted, fontFamily: fonts.sansSemibold, fontSize: 13.5 }}>
              {r.date ? formatDate(r.date, settings.date_format) : 'No date'}
            </RNText>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(243,226,176,0.92)', paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 }}>
              <Ionicons name={conf.icon} size={12} color="#08311F" />
              <RNText style={{ color: '#08311F', fontFamily: fonts.sansBold, fontSize: 11.5 }}>{conf.label}</RNText>
            </View>
            {r.date_ambiguous ? (
              <Ionicons name="alert-circle" size={16} color={t.colors.goldBright} />
            ) : null}
          </Row>
          <RNText style={{ color: t.colors.onHero, fontFamily: fonts.displayMedium, fontSize: 50, letterSpacing: -1.2, marginTop: 16 }}>
            {formatMoney(r.total, r.currency)}
          </RNText>
        </GradientHero>

        {/* ---------------- BODY ---------------- */}
        <View style={{ paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.lg }}>
          {/* Field cards: category (full), payment + tax (split). */}
          <FieldCard label="Category" onPress={onEdit}>
            <Row gap={8} align="center">
              {category ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: category.color }} /> : null}
              <RNText style={{ color: t.colors.text, fontFamily: fonts.sansBold, fontSize: 15.5 }}>{category?.name ?? 'Uncategorized'}</RNText>
            </Row>
          </FieldCard>
          <Row gap={t.spacing.md} align="stretch">
            <FieldCard label="Payment" style={{ flex: 1 }}>
              <RNText style={{ color: t.colors.text, fontFamily: fonts.sansBold, fontSize: 15.5 }}>{payment?.name ?? 'Not set'}</RNText>
            </FieldCard>
            <FieldCard label="Tax" style={{ flex: 1 }}>
              <RNText style={{ color: t.colors.text, fontFamily: fonts.sansBold, fontSize: 15.5 }}>
                {r.tax != null ? formatMoney(r.tax, r.currency) : '—'}
              </RNText>
            </FieldCard>
          </Row>

          {/* Extra classification chips (currency / tax cat / deductible / tags). */}
          {(taxCategory || r.is_deductible || r.tags.length > 0) ? (
            <Row gap={t.spacing.sm} wrap style={{ marginTop: t.spacing.xs, marginBottom: t.spacing.sm }}>
              <Chip label={r.currency} icon="cash-outline" />
              {taxCategory ? <Chip label={taxCategory.name} icon="briefcase-outline" /> : null}
              {r.is_deductible ? <Chip label={`${r.deductible_percent}% deductible`} icon="checkmark-circle" color={t.colors.success} selected /> : null}
              {r.tags.map((tag) => (
                <Chip key={tag.id} label={tag.name} color={tag.color} icon={tag.kind === 'job' ? 'briefcase-outline' : tag.kind === 'trip' ? 'airplane-outline' : 'pricetag-outline'} />
              ))}
            </Row>
          ) : null}

          {/* TASK 78 — Product recall alerts (best-effort, from local cache). */}
          {recalls.length > 0 ? (
            <View style={{ marginTop: t.spacing.xs, marginBottom: t.spacing.sm }}>
              {recalls.map((m) => (
                <View
                  key={m.recall.recall_id}
                  style={{
                    backgroundColor: t.colors.dangerTint,
                    borderRadius: t.radius.md,
                    borderWidth: 1,
                    borderColor: t.colors.danger,
                    padding: t.spacing.md,
                    marginBottom: t.spacing.sm,
                  }}
                >
                  <Row gap={8} align="center" style={{ marginBottom: 4 }}>
                    <Ionicons name="warning-outline" size={18} color={t.colors.danger} />
                    <RNText style={{ color: t.colors.danger, fontFamily: fonts.sansBold, fontSize: 12.5, letterSpacing: 0.4 }}>
                      POSSIBLE RECALL
                    </RNText>
                  </Row>
                  <RNText style={{ color: t.colors.text, fontFamily: fonts.sansSemibold, fontSize: 14 }}>
                    {m.recall.title || 'Recalled product'}
                  </RNText>
                  {m.recall.hazard ? (
                    <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 12.5, marginTop: 2 }}>
                      {m.recall.hazard}
                    </RNText>
                  ) : null}
                  <RNText style={{ color: t.colors.textFaint, fontFamily: fonts.sansMedium, fontSize: 11.5, marginTop: 2 }}>
                    Matched “{m.matchedTerm}”
                  </RNText>
                  <Row gap={t.spacing.sm} style={{ marginTop: t.spacing.sm }}>
                    {m.recall.url ? (
                      <Button title="View recall" icon="open-outline" variant="danger" size="sm" onPress={() => onOpenRecall(m)} />
                    ) : null}
                    <Button title="Dismiss" variant="ghost" size="sm" onPress={() => onDismissRecall(m)} />
                  </Row>
                </View>
              ))}
            </View>
          ) : null}

          {/* Memo. */}
          {r.memo ? (
            <FieldCard label="Memo">
              <RNText style={{ color: t.colors.text, fontFamily: fonts.sansMedium, fontSize: 14.5, lineHeight: 20 }}>{r.memo}</RNText>
            </FieldCard>
          ) : null}

          {/* Line items + emerald summary. */}
          <SectionLabel text={`Line items · ${r.line_items.length}`} />
          {r.line_items.length === 0 ? (
            <FieldCard>
              <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 14 }}>No itemized lines. Total was entered directly.</RNText>
            </FieldCard>
          ) : (
            <View>
              {r.line_items.map((li) => {
                const lt = (li.qty || 0) * (li.price || 0);
                return (
                  <Row key={li.id} gap={12} align="center" style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.colors.border }}>
                    <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: t.colors.brandTint, alignItems: 'center', justifyContent: 'center' }}>
                      <RNText style={{ color: t.colors.brand, fontFamily: fonts.sansExtra, fontSize: 12.5 }}>{li.qty}×</RNText>
                    </View>
                    <View style={{ flex: 1 }}>
                      <RNText style={{ color: li.included ? t.colors.text : t.colors.textMuted, fontFamily: fonts.sansSemibold, fontSize: 14.5, textDecorationLine: li.included ? 'none' : 'line-through' }} numberOfLines={1}>
                        {li.name || 'Item'}
                      </RNText>
                    </View>
                    <RNText style={{ color: li.included ? t.colors.text : t.colors.textMuted, fontFamily: fonts.display, fontSize: 15, textDecorationLine: li.included ? 'none' : 'line-through' }}>
                      {formatMoney(lt, r.currency)}
                    </RNText>
                  </Row>
                );
              })}
              {/* Emerald money summary */}
              <LinearGradient colors={[t.colors.brandLight, t.colors.brandDark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: t.radius.lg, padding: t.spacing.lg, marginTop: t.spacing.md, ...t.shadow(2) }}>
                <SummaryRow label="Subtotal" value={formatMoney(r.subtotal, r.currency)} />
                {r.tax != null ? <SummaryRow label="Tax" value={formatMoney(r.tax, r.currency)} /> : null}
                <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.16)', marginVertical: 8 }} />
                <Row justify="space-between" align="center">
                  <RNText style={{ color: t.colors.onHeroMuted, fontFamily: fonts.sansBold, fontSize: 14 }}>Total</RNText>
                  <RNText style={{ color: t.colors.onHero, fontFamily: fonts.display, fontSize: 22 }}>{formatMoney(r.total, r.currency)}</RNText>
                </Row>
              </LinearGradient>
            </View>
          )}

          {/* Original image(s). */}
          <SectionLabel text={pageUris.length > 1 ? `Images · ${pageUris.length}` : 'Original image'} />
          {viewerUris.length === 0 ? (
            <FieldCard>
              <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 14 }}>No image was attached to this receipt.</RNText>
            </FieldCard>
          ) : (
            <Row gap={t.spacing.md} wrap>
              {(pageUris.length > 0 ? pageUris : viewerUris).map((uri, i) => (
                <Pressable key={`${uri}-${i}`} onPress={() => openViewer(i)}>
                  <Image source={{ uri }} style={{ width: 96, height: 128, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.border }} contentFit="cover" />
                </Pressable>
              ))}
            </Row>
          )}
          {r.saved_filename ? (
            <RNText style={{ color: t.colors.textFaint, fontFamily: fonts.sansMedium, fontSize: 11.5, marginTop: t.spacing.sm }} numberOfLines={1}>{r.saved_filename}</RNText>
          ) : null}

          {/* TASK 47 — capture location. No native map view (react-native-maps
              isn't bundled); a static coordinate card + Open-in-Maps deep link
              hands off to the device's own maps app. */}
          {hasLocation ? (
            <>
              <SectionLabel text="Location" />
              <FieldCard>
                <Row justify="space-between" align="center">
                  <Row gap={10} align="center" style={{ flex: 1, paddingRight: t.spacing.sm }}>
                    <View style={{ width: 36, height: 36, borderRadius: t.radius.md, backgroundColor: t.colors.brandTint, alignItems: 'center', justifyContent: 'center' }}>
                      <Ionicons name="location" size={18} color={t.colors.brand} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <RNText style={{ color: t.colors.text, fontFamily: fonts.sansBold, fontSize: 14 }}>
                        Where it was captured
                      </RNText>
                      <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 12.5, marginTop: 2 }} numberOfLines={1}>
                        {formatCoords(r.captured_lat!, r.captured_lng!)}
                      </RNText>
                    </View>
                  </Row>
                </Row>
                <Button
                  title="Open in Maps"
                  icon="map-outline"
                  variant="secondary"
                  size="sm"
                  style={{ marginTop: t.spacing.md, alignSelf: 'flex-start' }}
                  onPress={onOpenInMaps}
                />
              </FieldCard>
            </>
          ) : null}

          {/* Protections. */}
          {hasProtections ? (
            <>
              <SectionLabel text="Protections" />
              <FieldCard>
                {r.return_deadline ? (
                  <Row justify="space-between" align="center" style={{ paddingVertical: 4 }}>
                    <Row gap={10} align="center">
                      <Ionicons name="return-down-back-outline" size={18} color={urgencyColor(r.return_deadline, t)} />
                      <View>
                        <RNText style={{ color: t.colors.text, fontFamily: fonts.sansSemibold, fontSize: 14.5 }}>Return window</RNText>
                        <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 12.5 }}>{formatDate(r.return_deadline, settings.date_format)}</RNText>
                      </View>
                    </Row>
                    <RNText style={{ color: urgencyColor(r.return_deadline, t), fontFamily: fonts.sansBold, fontSize: 13 }}>{relativeDays(r.return_deadline)}</RNText>
                  </Row>
                ) : null}
                {r.return_deadline && r.warranty_deadline ? <View style={{ height: 1, backgroundColor: t.colors.border, marginVertical: 8 }} /> : null}
                {r.warranty_deadline ? (
                  <Row justify="space-between" align="center" style={{ paddingVertical: 4 }}>
                    <Row gap={10} align="center">
                      <Ionicons name="shield-checkmark-outline" size={18} color={urgencyColor(r.warranty_deadline, t)} />
                      <View>
                        <RNText style={{ color: t.colors.text, fontFamily: fonts.sansSemibold, fontSize: 14.5 }}>Warranty</RNText>
                        <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 12.5 }}>{formatDate(r.warranty_deadline, settings.date_format)}</RNText>
                      </View>
                    </Row>
                    <RNText style={{ color: urgencyColor(r.warranty_deadline, t), fontFamily: fonts.sansBold, fontSize: 13 }}>{relativeDays(r.warranty_deadline)}</RNText>
                  </Row>
                ) : null}
              </FieldCard>
            </>
          ) : null}

          {/* TASK 80 — warranty / return claim packet (serial + photo + receipt). */}
          {hasProtections ? (
            <View style={{ marginTop: t.spacing.sm }}>
              <Button
                title="Prepare warranty claim"
                icon="document-attach-outline"
                variant="secondary"
                onPress={onWarrantyClaim}
              />
            </View>
          ) : null}

          {/* TASK 77 — credit-card purchase/return/warranty protection hints. */}
          {benefitHints.length > 0 ? (
            <>
              <SectionLabel text={`${payment?.name ?? 'Card'} benefits`} />
              <FieldCard>
                {benefitHints.map((h, i) => (
                  <View key={h.kind} style={{ paddingVertical: 6 }}>
                    {i > 0 ? <View style={{ height: 1, backgroundColor: t.colors.border, marginBottom: 10 }} /> : null}
                    <Row gap={10} align="flex-start">
                      <Ionicons name="card-outline" size={16} color={t.colors.brand} style={{ marginTop: 2 }} />
                      <View style={{ flex: 1 }}>
                        <RNText style={{ color: t.colors.text, fontFamily: fonts.sansBold, fontSize: 13.5 }}>{h.title}</RNText>
                        <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 12.5, marginTop: 2, lineHeight: 18 }}>
                          {h.detail}
                        </RNText>
                      </View>
                    </Row>
                  </View>
                ))}
                <RNText style={{ color: t.colors.textFaint, fontFamily: fonts.sansMedium, fontSize: 11, marginTop: 8 }}>
                  General guidance — check your card’s benefits guide for exact terms.
                </RNText>
              </FieldCard>
            </>
          ) : null}

          {/* TASK 81 — mail-in rebates tracked for this receipt. */}
          <SectionLabel text={rebates.length ? `Rebates · ${rebates.length}` : 'Rebates'} />
          {rebates.map((rb) => (
            <FieldCard key={rb.id}>
              <Row justify="space-between" align="center">
                <View style={{ flex: 1, paddingRight: t.spacing.sm }}>
                  <RNText style={{ color: t.colors.text, fontFamily: fonts.sansBold, fontSize: 14 }}>
                    {rb.description || 'Mail-in rebate'}
                  </RNText>
                  <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 12.5 }}>
                    {rb.status}
                    {rb.submission_deadline ? ` · submit by ${formatDate(rb.submission_deadline, settings.date_format)}` : ''}
                  </RNText>
                </View>
                <RNText style={{ color: t.colors.text, fontFamily: fonts.display, fontSize: 15 }}>
                  {formatMoney(rb.amount, rb.currency)}
                </RNText>
              </Row>
            </FieldCard>
          ))}
          <Chip label="Add rebate" icon="add" onPress={() => setProtectionSheet('rebate')} />

          {/* TASK 79 — price-drop / price-protection claims for this receipt. */}
          <SectionLabel text={priceProtections.length ? `Price protection · ${priceProtections.length}` : 'Price protection'} />
          {priceProtections.map((pp) => {
            const refund = Math.max(0, pp.original_price - pp.current_price);
            return (
              <FieldCard key={pp.id}>
                <Row justify="space-between" align="center">
                  <View style={{ flex: 1, paddingRight: t.spacing.sm }}>
                    <RNText style={{ color: t.colors.text, fontFamily: fonts.sansBold, fontSize: 14 }}>
                      {pp.item_name || 'Price drop'}
                    </RNText>
                    <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 12.5 }}>
                      {pp.status}
                      {pp.claim_deadline ? ` · claim by ${formatDate(pp.claim_deadline, settings.date_format)}` : ''}
                    </RNText>
                  </View>
                  <RNText style={{ color: t.colors.success, fontFamily: fonts.display, fontSize: 15 }}>
                    {formatMoney(refund, pp.currency)}
                  </RNText>
                </Row>
              </FieldCard>
            );
          })}
          <Chip label="Add price drop" icon="add" onPress={() => setProtectionSheet('price_protection')} />

          {/* Folders — many-to-many labels (never duplicates the receipt). */}
          <SectionLabel text={folders.length ? `Folders · ${folders.length}` : 'Folders'} />
          <Row gap={t.spacing.sm} wrap align="center">
            {folders.map((f) => (
              <Chip
                key={f.id}
                label={f.name}
                color={f.color}
                icon="folder-outline"
                onPress={() => router.push({ pathname: '/folder/[id]', params: { id: f.id } })}
              />
            ))}
            <Chip label="Add to folders" icon="add" onPress={() => setFolderPickerOpen(true)} />
          </Row>

          {/* Version history: revert-to-original + edit-change log. */}
          {(original || auditLog.length > 0) ? (
            <>
              <SectionLabel text="Version history" />
              <FieldCard>
                {original ? (
                  <Row justify="space-between" align="center" style={{ paddingVertical: 4 }}>
                    <Row gap={10} align="center" style={{ flex: 1 }}>
                      <Ionicons name="sparkles-outline" size={18} color={t.colors.brand} />
                      <View style={{ flex: 1 }}>
                        <RNText style={{ color: t.colors.text, fontFamily: fonts.sansSemibold, fontSize: 14.5 }}>Original AI extraction</RNText>
                        <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 12.5 }}>
                          Captured {formatDate(original.created_at.slice(0, 10), settings.date_format)}
                        </RNText>
                      </View>
                    </Row>
                    <Pressable onPress={onRevert} hitSlop={6} accessibilityLabel="Revert to original">
                      <RNText style={{ color: t.colors.brand, fontFamily: fonts.sansBold, fontSize: 13 }}>Revert</RNText>
                    </Pressable>
                  </Row>
                ) : null}
                {original && auditLog.length > 0 ? (
                  <View style={{ height: 1, backgroundColor: t.colors.border, marginVertical: 8 }} />
                ) : null}
                {auditLog.slice(0, 12).map((entry) => (
                  <View key={entry.id} style={{ paddingVertical: 5 }}>
                    <RNText style={{ color: t.colors.text, fontFamily: fonts.sansSemibold, fontSize: 13 }}>
                      {prettyField(entry.field)}
                    </RNText>
                    <RNText style={{ color: t.colors.textMuted, fontFamily: fonts.sansMedium, fontSize: 12 }}>
                      {entry.old_value ?? '—'} → {entry.new_value ?? '—'} · {formatDate(entry.created_at.slice(0, 10), settings.date_format)}
                    </RNText>
                  </View>
                ))}
              </FieldCard>
            </>
          ) : null}

          {/* Primary action. */}
          <View style={{ marginTop: t.spacing.xl }}>
            <Button title="Edit receipt" icon="create-outline" size="lg" onPress={onEdit} />
          </View>
        </View>
      </ScrollView>

      <FolderPickerSheet
        visible={folderPickerOpen}
        title="Add to folders"
        selected={folders.map((f) => f.id)}
        onConfirm={onSetFolders}
        onClose={() => setFolderPickerOpen(false)}
      />

      {protectionSheet ? (
        <AddProtectionSheet
          visible
          kind={protectionSheet}
          receiptId={r.id}
          vendor={r.vendor}
          currency={r.currency}
          paidAmount={r.total}
          dateFormat={settings.date_format}
          onClose={() => setProtectionSheet(null)}
          onSaved={() => {
            setProtectionSheet(null);
            load();
          }}
        />
      ) : null}

      <LoadingOverlay visible={busy} message="Working…" />
    </View>
  );
}

/** Human-readable label for an audit-log field key. */
function prettyField(field: string): string {
  const map: Record<string, string> = {
    vendor: 'Vendor',
    date: 'Date',
    total: 'Total',
    tax: 'Tax',
    currency: 'Currency',
    category_id: 'Category',
    payment_method_id: 'Payment method',
    memo: 'Memo',
    tax_category_id: 'Tax category',
    is_deductible: 'Deductible',
    deductible_percent: 'Deductible %',
    line_items: 'Line items',
    reverted: 'Reverted',
  };
  return map[field] ?? field;
}

/** Translucent circular icon button used on the emerald hero. */
function HeroCircle({ icon, onPress, label }: { icon: IconName; onPress: () => void; label: string }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons name={icon} size={19} color={t.colors.onHero} />
    </Pressable>
  );
}

/** A labelled info card (eyebrow label + value), optionally tappable to Edit. */
function FieldCard({ label, children, onPress, style }: { label?: string; children: React.ReactNode; onPress?: () => void; style?: any }) {
  const t = useTheme();
  const inner = (
    <View style={[{ backgroundColor: t.colors.card, borderRadius: t.radius.md, borderWidth: 1, borderColor: t.colors.border, padding: t.spacing.md, marginBottom: t.spacing.sm, ...t.shadow(1) }, style]}>
      <Row justify="space-between" align="center">
        <View style={{ flex: 1 }}>
          {label ? <RNText style={{ color: t.colors.textFaint, fontFamily: fonts.sansBold, fontSize: 10.5, letterSpacing: 1.2, marginBottom: 5 }}>{label.toUpperCase()}</RNText> : null}
          {children}
        </View>
        {onPress ? <Ionicons name="create-outline" size={18} color={t.colors.textFaint} /> : null}
      </Row>
    </View>
  );
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => (pressed ? { opacity: 0.85 } : null)}>{inner}</Pressable> : inner;
}

function SectionLabel({ text }: { text: string }) {
  const t = useTheme();
  return (
    <RNText style={{ color: t.colors.textFaint, fontFamily: fonts.sansExtra, fontSize: 11.5, letterSpacing: 1.6, marginTop: t.spacing.lg, marginBottom: t.spacing.sm }}>
      {text.toUpperCase()}
    </RNText>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <Row justify="space-between" align="center" style={{ paddingVertical: 3 }}>
      <RNText style={{ color: t.colors.onHeroMuted, fontFamily: fonts.sansSemibold, fontSize: 13.5 }}>{label}</RNText>
      <RNText style={{ color: t.colors.onHero, fontFamily: fonts.sansSemibold, fontSize: 13.5 }}>{value}</RNText>
    </Row>
  );
}
