/**
 * Settings — the app's control center. Premium unlock status, organization
 * editors (categories / payment methods / tags / tax categories), scanning &
 * file preferences (filename template, default currency, image format, date
 * format), mileage rate, protection-reminder lead times, the email-forwarding
 * address, backup & restore, reports, and About / share-with-friends.
 *
 * Every inline control persists immediately via useSettings().update; nothing
 * here is auto-finalized elsewhere. Lookup lists are refreshed on focus so the
 * counts shown on the organization rows stay current after edits in the
 * dedicated CRUD screens.
 */
import { useCallback, useState } from 'react';
import { Alert, Switch, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import {
  Screen,
  Card,
  Button,
  Text,
  Row,
  SectionHeader,
  ListRow,
  TextField,
  SegmentedControl,
  SelectSheet,
  Badge,
  Divider,
  useTheme,
  type SelectOption,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import { useLookups } from '@/store/lookups';
import { parseMoney } from '@/lib/money';
import * as DB from '@/db';
import { authenticate } from '@/services/appLock';
import { exportReceiptsHtml, shareFile } from '@/services/exporters';
import { exportAuditPacket } from '@/services/auditVaultService';
import type { ImageFormat } from '@/types';

// Common ISO 4217 codes offered in the default-currency picker. Mirrors the
// symbol table in @/lib/money so every choice renders cleanly via formatMoney.
const CURRENCY_OPTIONS: SelectOption[] = [
  { label: 'US Dollar', value: 'USD', subtitle: '$' },
  { label: 'Euro', value: 'EUR', subtitle: '€' },
  { label: 'British Pound', value: 'GBP', subtitle: '£' },
  { label: 'Japanese Yen', value: 'JPY', subtitle: '¥' },
  { label: 'Canadian Dollar', value: 'CAD', subtitle: 'C$' },
  { label: 'Australian Dollar', value: 'AUD', subtitle: 'A$' },
  { label: 'Swiss Franc', value: 'CHF', subtitle: 'CHF' },
  { label: 'Indian Rupee', value: 'INR', subtitle: '₹' },
  { label: 'Singapore Dollar', value: 'SGD', subtitle: 'S$' },
  { label: 'Malaysian Ringgit', value: 'MYR', subtitle: 'RM' },
  { label: 'Chinese Yuan', value: 'CNY', subtitle: '¥' },
  { label: 'Mexican Peso', value: 'MXN', subtitle: 'MX$' },
  { label: 'Brazilian Real', value: 'BRL', subtitle: 'R$' },
];

// Supported date formats. Labelled with a worked example so users can pick the
// shape that matches their region and reduce ambiguity at extraction time.
const DATE_FORMAT_OPTIONS: SelectOption[] = [
  { label: 'MM/DD/YYYY', value: 'MM/DD/YYYY', subtitle: '06/04/2026' },
  { label: 'DD/MM/YYYY', value: 'DD/MM/YYYY', subtitle: '04/06/2026' },
  { label: 'YYYY-MM-DD', value: 'YYYY-MM-DD', subtitle: '2026-06-04' },
  { label: 'MMM D YYYY', value: 'MMM D YYYY', subtitle: 'Jun 4 2026' },
];

export default function SettingsScreen() {
  const t = useTheme();
  const { settings, update } = useSettings();
  const lookups = useLookups();

  // Which inline picker sheet (if any) is open.
  const [sheet, setSheet] = useState<'currency' | 'date_format' | null>(null);

  // Guards the one-shot HTML export and the destructive clear-all so we don't
  // fire either twice while it's in flight.
  const [exportingHtml, setExportingHtml] = useState(false);
  const [exportingAudit, setExportingAudit] = useState(false);
  const [clearing, setClearing] = useState(false);

  // App Lock requires a successful biometric/passcode prompt BEFORE we persist
  // the on state, so the user can't lock themselves behind an auth they can't
  // pass. Turning it off is unguarded. authenticate() fails open on devices
  // without supported hardware/enrollment.
  const toggleAppLock = async (next: boolean) => {
    if (!next) {
      update({ app_lock: false });
      return;
    }
    const ok = await authenticate('Enable App Lock for ReceiptSnap');
    if (ok) {
      update({ app_lock: true });
    } else {
      Alert.alert('App Lock not enabled', 'Biometric authentication was cancelled or failed.');
    }
  };

  // Export every receipt as a single browse-on-a-computer HTML page, then hand
  // it to the share sheet. Export is part of the one-time purchase, so locked
  // users are routed to the paywall instead.
  const onExportHtml = async () => {
    if (exportingHtml) return;
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
    setExportingHtml(true);
    try {
      const uri = await exportReceiptsHtml({});
      await shareFile(uri);
      Alert.alert('Export ready', 'Your receipts were exported as an HTML page.');
    } catch {
      Alert.alert('Export failed', 'Could not export your receipts. Please try again.');
    } finally {
      setExportingHtml(false);
    }
  };

  // TASK 84 — audit-defense export: an itemized export (CSV + PDF) bundled with
  // every retained ORIGINAL receipt image, shared as a complete audit packet.
  const onExportAuditPacket = async () => {
    if (exportingAudit) return;
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
    setExportingAudit(true);
    try {
      const res = await exportAuditPacket({});
      Alert.alert(
        'Audit packet ready',
        `Packaged ${res.receiptCount} receipt(s): an itemized export plus ${res.imageUris.length} original image(s).`,
      );
    } catch (e) {
      const msg = e instanceof Error && e.message === 'empty-range'
        ? 'There are no receipts to package yet.'
        : 'Could not build the audit packet. Please try again.';
      Alert.alert('Audit packet', msg);
    } finally {
      setExportingAudit(false);
    }
  };

  // Destructive, irreversible wipe of all local data. Double-confirm, then
  // delete every receipt plus mileage trips, cash expenses and statement
  // imports. Offline-first means there's no server copy — this is final.
  const onClearAllData = () => {
    Alert.alert(
      'Clear all data?',
      'This permanently deletes every receipt, mileage trip, cash expense and imported statement on this device. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              'Are you absolutely sure?',
              'There is no cloud copy unless you backed up. Deleting now is permanent.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete everything', style: 'destructive', onPress: clearAllData },
              ],
            ),
        },
      ],
    );
  };

  const clearAllData = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      const receipts = await DB.listReceipts({ status: 'all' });
      await DB.deleteReceipts(receipts.map((r) => r.id));

      const trips = await DB.Mileage.listTrips();
      await Promise.all(trips.map((trip) => DB.Mileage.deleteTrip(trip.id)));

      const cashExpenses = await DB.CashExpenses.listCashExpenses();
      await Promise.all(cashExpenses.map((c) => DB.CashExpenses.deleteCashExpense(c.id)));

      const imports = await DB.Statements.listImports();
      await Promise.all(imports.map((imp) => DB.Statements.deleteImport(imp.id)));

      // Standalone purchase-protection records (FK is SET NULL, so they survive
      // receipt deletion) — remove them too so "clear all" really clears all.
      const rebates = await DB.Rebates.listRebates();
      await Promise.all(rebates.map((rb) => DB.Rebates.deleteRebate(rb.id)));
      const pps = await DB.PriceProtections.listPriceProtections();
      await Promise.all(pps.map((pp) => DB.PriceProtections.deletePriceProtection(pp.id)));

      Alert.alert('All data cleared', 'Your receipts, trips, cash expenses and statements were deleted.');
    } catch {
      Alert.alert('Could not clear data', 'Something went wrong while deleting. Please try again.');
    } finally {
      setClearing(false);
    }
  };

  // Numeric / text fields are edited as local strings, then committed onBlur so
  // we don't write a partial number to settings on every keystroke.
  const [mileageRate, setMileageRate] = useState(String(settings.mileage_rate));
  const [returnDays, setReturnDays] = useState(String(settings.notify_return_days_before));
  const [warrantyDays, setWarrantyDays] = useState(String(settings.notify_warranty_days_before));

  // Keep lookup counts fresh after edits in the CRUD child screens.
  useFocusEffect(
    useCallback(() => {
      lookups.refresh();
    }, [lookups]),
  );

  const currencyLabel =
    CURRENCY_OPTIONS.find((c) => c.value === settings.default_currency)?.label ??
    settings.default_currency;

  // Commit a possibly-empty whole-number reminder field, clamped to >= 0.
  const commitInt = (raw: string, key: 'notify_return_days_before' | 'notify_warranty_days_before') => {
    const n = Math.max(0, Math.round(parseMoney(raw)));
    update({ [key]: n });
  };

  const shareWithFriends = async () => {
    // Share a plain invite link; expo-sharing falls back gracefully where a
    // text/URL share isn't supported by the host platform.
    if (await Sharing.isAvailableAsync()) {
      try {
        await Sharing.shareAsync('https://receiptsnap.app', {
          dialogTitle: 'Try ReceiptSnap — the receipt scanner that gets it right.',
        });
      } catch {
        /* ignore — user dismissed or platform unsupported */
      }
    }
  };

  return (
    <Screen scroll edges={['top']}>
      <Text variant="title">Settings</Text>

      {/* Premium / unlock status */}
      <Card style={{ marginTop: t.spacing.lg }}>
        <Row justify="space-between" align="center">
          <Text variant="subheading">ReceiptSnap {settings.is_unlocked ? 'Pro' : 'Free'}</Text>
          {settings.is_unlocked ? (
            <Badge label="Unlocked" icon="checkmark-circle" color={t.colors.success} background={t.colors.successTint} />
          ) : (
            <Badge label={`${Math.max(0, settings.free_scan_limit - settings.scan_count)} free`} icon="lock-open-outline" />
          )}
        </Row>
        <Text variant="body" color={t.colors.textMuted} style={{ marginTop: 6 }}>
          {settings.is_unlocked
            ? 'Unlimited scans, exports and cloud backup. One-time purchase — no subscriptions, no ads.'
            : 'Unlock unlimited scans, all exports and cloud backup with a single one-time purchase.'}
        </Text>
        {!settings.is_unlocked ? (
          <Button
            title="Unlock $9.99"
            icon="sparkles"
            style={{ marginTop: t.spacing.md }}
            onPress={() => router.push('/paywall')}
          />
        ) : null}
      </Card>

      {/* Organization — CRUD editors live in their own screens */}
      <SectionHeader title="Organization" />
      <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
        <ListRow
          icon="pricetags-outline"
          title="Categories"
          subtitle="Tap a category to nest it as a subcategory"
          rightText={String(lookups.categories.length)}
          onPress={() => router.push('/settings/categories')}
        />
        <Divider spacing={0} />
        <ListRow
          icon="folder-outline"
          title="Folders"
          subtitle="Group by Client / Project / Trip — manage in the Receipts tab"
          onPress={() => router.push('/(tabs)/history')}
        />
        <Divider spacing={0} />
        <ListRow
          icon="card-outline"
          title="Payment Methods"
          rightText={String(lookups.paymentMethods.length)}
          onPress={() => router.push('/settings/payment-methods')}
        />
        <Divider spacing={0} />
        <ListRow
          icon="bookmark-outline"
          title="Tags & Jobs"
          rightText={String(lookups.tags.length)}
          onPress={() => router.push('/settings/tags')}
        />
        <Divider spacing={0} />
        <ListRow
          icon="calculator-outline"
          title="Tax Categories"
          rightText={String(lookups.taxCategories.length)}
          onPress={() => router.push('/settings/tax-categories')}
        />
        <Divider spacing={0} />
        <ListRow
          icon="pie-chart-outline"
          title="Budgets"
          subtitle="Monthly cap per category with colored gauges on Home"
          onPress={() => router.push('/settings/budgets')}
        />
      </Card>

      {/* Scanning & files */}
      <SectionHeader title="Scanning & files" />
      <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
        <ListRow
          icon="text-outline"
          title="Filename Template"
          subtitle={settings.filename_template}
          onPress={() => router.push('/settings/filename')}
        />
        <Divider spacing={0} />
        <ListRow
          icon="cash-outline"
          title="Default currency"
          rightText={`${currencyLabel} (${settings.default_currency})`}
          onPress={() => setSheet('currency')}
        />
        <Divider spacing={0} />
        <ListRow
          icon="calendar-outline"
          title="Date format"
          rightText={settings.date_format}
          onPress={() => setSheet('date_format')}
        />
      </Card>

      {/* Image format — segmented inline control */}
      <Card style={{ marginTop: t.spacing.md }}>
        <Text variant="label" color={t.colors.textMuted} style={{ marginBottom: t.spacing.sm }}>
          IMAGE FORMAT
        </Text>
        <SegmentedControl<ImageFormat>
          options={[
            { label: 'JPG', value: 'jpg' },
            { label: 'PNG', value: 'png' },
          ]}
          value={settings.image_format}
          onChange={(v) => update({ image_format: v })}
        />
      </Card>

      {/* Privacy & Processing — competitor-parity controls. Each toggle persists
          immediately; App Lock additionally requires passing auth before turning
          on. The HTML export and Clear-all live here as data-handling actions. */}
      <SectionHeader title="Privacy & Processing" />
      <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
        <ListRow
          icon="crop-outline"
          title="Auto-Crop & Enhance"
          subtitle="Auto-crop and enhance captures; off keeps the original"
          right={
            <Switch
              value={settings.auto_crop}
              onValueChange={(v) => update({ auto_crop: v })}
              trackColor={{ true: t.colors.brand }}
            />
          }
        />
        <Divider spacing={0} />
        <ListRow
          icon="scan-outline"
          title="Auto-Straighten (De-skew)"
          subtitle="Straighten slightly crooked photos on-device before reading"
          right={
            <Switch
              value={settings.enhance_deskew}
              disabled={!settings.auto_crop}
              onValueChange={(v) => update({ enhance_deskew: v })}
              trackColor={{ true: t.colors.brand }}
            />
          }
        />
        <Divider spacing={0} />
        <ListRow
          icon="lock-closed-outline"
          title="App Lock"
          subtitle="Require biometrics to open History & Statistics"
          right={
            <Switch
              value={settings.app_lock}
              onValueChange={toggleAppLock}
              trackColor={{ true: t.colors.brand }}
            />
          }
        />
      </Card>
      <Button
        title="Export all as HTML"
        variant="secondary"
        icon="globe-outline"
        loading={exportingHtml}
        fullWidth
        style={{ marginTop: t.spacing.md }}
        onPress={onExportHtml}
      />
      <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: 6 }}>
        Builds a page to view all your receipts on a computer.
      </Text>
      <Button
        title="Audit defense export"
        variant="secondary"
        icon="shield-checkmark-outline"
        loading={exportingAudit}
        fullWidth
        style={{ marginTop: t.spacing.md }}
        onPress={onExportAuditPacket}
      />
      <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: 6 }}>
        Packages an itemized export plus every retained original image as proof.
      </Text>
      <Card padded={false} style={{ marginTop: t.spacing.md, paddingHorizontal: t.spacing.lg }}>
        <ListRow
          icon="trash-outline"
          iconColor={t.colors.danger}
          title="Clear all data"
          subtitle="Permanently delete every receipt, trip, cash expense and statement"
          destructive
          right={null}
          onPress={onClearAllData}
        />
      </Card>

      {/* Mileage — opt-in. The toggle hides the Mileage tab for users who don't
          drive for work; the per-mile rate only matters when it's enabled. */}
      <SectionHeader title="Mileage" />
      <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
        <ListRow
          icon="car-sport-outline"
          title="Show Mileage"
          subtitle="Track business miles for tax deductions; off hides the tab"
          right={
            <Switch
              value={settings.mileage_enabled}
              onValueChange={(v) => update({ mileage_enabled: v })}
              trackColor={{ true: t.colors.brand }}
            />
          }
        />
        {settings.mileage_enabled ? (
          <>
            <Divider spacing={0} />
            <View style={{ paddingVertical: t.spacing.md }}>
              <TextField
                label="Rate per mile"
                value={mileageRate}
                onChangeText={setMileageRate}
                onBlur={() => update({ mileage_rate: parseMoney(mileageRate) })}
                keyboardType="decimal-pad"
                prefix="$"
                placeholder="0.67"
                style={{ marginBottom: 0 }}
              />
            </View>
          </>
        ) : null}
      </Card>

      {/* Reminders — protection lead times */}
      <SectionHeader title="Reminders" />
      <Card>
        <Text variant="body" color={t.colors.textMuted} style={{ marginBottom: t.spacing.md }}>
          How many days before a deadline you want to be reminded.
        </Text>
        <Row gap={t.spacing.md} align="flex-start">
          <View style={{ flex: 1 }}>
            <TextField
              label="Return window"
              value={returnDays}
              onChangeText={setReturnDays}
              onBlur={() => commitInt(returnDays, 'notify_return_days_before')}
              keyboardType="number-pad"
              placeholder="3"
              style={{ marginBottom: 0 }}
            />
          </View>
          <View style={{ flex: 1 }}>
            <TextField
              label="Warranty"
              value={warrantyDays}
              onChangeText={setWarrantyDays}
              onBlur={() => commitInt(warrantyDays, 'notify_warranty_days_before')}
              keyboardType="number-pad"
              placeholder="30"
              style={{ marginBottom: 0 }}
            />
          </View>
        </Row>
      </Card>

      {/* Email forwarding — borrowed-from-Expensify e-receipt ingestion */}
      <SectionHeader title="Email forwarding" />
      <Card>
        <Text variant="body" color={t.colors.textMuted}>
          Forward any e-receipt to this address and it'll appear in your pending list to review.
        </Text>
        {settings.forwarding_address ? (
          <>
            <Text variant="body" weight="600" style={{ marginTop: t.spacing.sm }} numberOfLines={1}>
              {settings.forwarding_address}
            </Text>
            <Button
              title="Copy address"
              variant="ghost"
              icon="copy-outline"
              size="sm"
              style={{ marginTop: t.spacing.md, alignSelf: 'flex-start' }}
              onPress={() => Clipboard.setStringAsync(settings.forwarding_address)}
            />
          </>
        ) : (
          <Text variant="body" color={t.colors.textMuted} style={{ marginTop: t.spacing.sm }}>
            Your address will appear here once it's been set up from the Home screen.
          </Text>
        )}
      </Card>

      {/* Backup & reports */}
      <SectionHeader title="Backup & reports" />
      <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
        <ListRow
          icon="cloud-upload-outline"
          title="Backup & Restore"
          subtitle="Your own Google Drive or OneDrive"
          onPress={() => router.push('/settings/backup')}
        />
        <Divider spacing={0} />
        <ListRow
          icon="calculator-outline"
          title="Tax Report"
          subtitle="Schedule C-style deductible summary"
          onPress={() => router.push('/tax-report')}
        />
        <Divider spacing={0} />
        <ListRow
          icon="git-compare-outline"
          title="Statement Matching"
          subtitle="Reconcile receipts against a CSV statement"
          onPress={() => router.push('/statement')}
        />
      </Card>

      {/* About & sharing */}
      <SectionHeader title="About" />
      <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
        <ListRow
          icon="map-outline"
          title="Roadmap & Feature Requests"
          subtitle="See what's coming and vote on what's next"
          onPress={() => router.push('/settings/roadmap')}
        />
        <Divider spacing={0} />
        <ListRow icon="information-circle-outline" title="About ReceiptSnap" onPress={() => router.push('/settings/about')} />
        <Divider spacing={0} />
        <ListRow icon="share-social-outline" title="Share with friends" onPress={shareWithFriends} />
      </Card>

      {/* Inline pickers */}
      <SelectSheet
        visible={sheet === 'currency'}
        title="Default currency"
        options={CURRENCY_OPTIONS}
        selected={[settings.default_currency]}
        onClose={() => setSheet(null)}
        onSelect={(v) => {
          if (v[0]) update({ default_currency: v[0] });
        }}
      />
      <SelectSheet
        visible={sheet === 'date_format'}
        title="Date format"
        options={DATE_FORMAT_OPTIONS}
        selected={[settings.date_format]}
        onClose={() => setSheet(null)}
        onSelect={(v) => {
          if (v[0]) update({ date_format: v[0] });
        }}
      />
    </Screen>
  );
}
