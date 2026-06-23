/**
 * Protections (V2 headline) — active return windows and warranties, soonest
 * first, so users actually claim them before they lapse. Built from receipt-
 * and item-level deadlines by protectionsService.
 */
import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  Screen,
  Card,
  Text,
  Row,
  Badge,
  Button,
  SectionHeader,
  ListRow,
  EmptyState,
  useTheme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import { listProtections } from '@/services/protectionsService';
import {
  refreshRecalls,
  findMatches,
  notifyMatches,
} from '@/services/recallService';
import { formatDate, relativeDays } from '@/lib/dates';
import type { ProtectionEntry, RecallMatch } from '@/types';

function urgencyColor(days: number, theme: ReturnType<typeof useTheme>) {
  if (days < 0) return theme.colors.textMuted;
  if (days <= 3) return theme.colors.danger;
  if (days <= 14) return theme.colors.warning;
  return theme.colors.success;
}

export default function ProtectionsScreen() {
  const t = useTheme();
  const { settings } = useSettings();
  const [entries, setEntries] = useState<ProtectionEntry[]>([]);
  const [recalls, setRecalls] = useState<RecallMatch[]>([]);
  const [checking, setChecking] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useFocusEffect(
    useCallback(() => {
      listProtections()
        .then(setEntries)
        .finally(() => setLoaded(true));
      // Show any recall matches already known from the local cache (no fetch).
      findMatches().then(setRecalls).catch(() => setRecalls([]));
    }, []),
  );

  // TASK 78 — on-demand recall check: refresh the CPSC cache, re-match, notify.
  const onCheckRecalls = useCallback(async () => {
    setChecking(true);
    try {
      const res = await refreshRecalls({ force: true });
      const matches = await findMatches();
      setRecalls(matches);
      await notifyMatches(matches);
      if (matches.length === 0) {
        Alert.alert(
          'No recalls found',
          res.online
            ? 'None of your purchases match recent recalls.'
            : 'You appear offline — checked against the cached recall list and found no matches.',
        );
      }
    } finally {
      setChecking(false);
    }
  }, []);

  const returns = entries.filter((e) => e.kind === 'return' && e.daysRemaining >= 0);
  const warranties = entries.filter((e) => e.kind === 'warranty' && e.daysRemaining >= 0);

  const renderRow = (e: ProtectionEntry) => {
    const color = urgencyColor(e.daysRemaining, t);
    return (
      <ListRow
        key={`${e.kind}-${e.receiptId}-${e.lineItemId ?? 'r'}`}
        icon={e.kind === 'return' ? 'return-down-back-outline' : 'shield-checkmark-outline'}
        iconColor={color}
        title={e.itemName || e.vendor}
        subtitle={`${e.vendor}${e.serialNumber ? ` · S/N ${e.serialNumber}` : ''}`}
        right={
          <View style={{ alignItems: 'flex-end' }}>
            <Text variant="label" color={color}>
              {relativeDays(e.deadline)}
            </Text>
            <Text variant="caption" color={t.colors.textMuted}>
              {formatDate(e.deadline, settings.date_format)}
            </Text>
          </View>
        }
        onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: e.receiptId } })}
      />
    );
  };

  return (
    <Screen scroll edges={['top']}>
      <Row justify="space-between" align="center">
        <Text variant="title">Protections</Text>
        <Badge
          label={`${returns.length + warranties.length} active`}
          color={t.colors.brand}
          background={t.colors.brandTint}
        />
      </Row>

      {/* TASK 78 — product recall alerts. */}
      <View style={{ marginTop: t.spacing.md }}>
        <Button
          title={checking ? 'Checking recalls…' : 'Check for product recalls'}
          icon="warning-outline"
          variant="secondary"
          loading={checking}
          onPress={onCheckRecalls}
        />
      </View>
      {recalls.length > 0 ? (
        <>
          <SectionHeader title={`Recall alerts (${recalls.length})`} />
          <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
            {recalls.map((m, i) => (
              <View key={`${m.receiptId}-${m.recall.recall_id}`}>
                {i > 0 ? <View style={{ height: 1, backgroundColor: t.colors.border }} /> : null}
                <ListRow
                  icon="warning-outline"
                  iconColor={t.colors.danger}
                  title={m.recall.title || 'Recalled product'}
                  subtitle={`Matched “${m.matchedTerm}”${m.recall.hazard ? ` · ${m.recall.hazard}` : ''}`}
                  onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: m.receiptId } })}
                />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {loaded && returns.length === 0 && warranties.length === 0 ? (
        <EmptyState
          icon="shield-checkmark-outline"
          title="No active protections"
          message="When you scan receipts for returnable or warrantied purchases, ReceiptSnap tracks the deadlines here and reminds you before they expire."
        />
      ) : (
        <>
          {returns.length > 0 ? (
            <>
              <SectionHeader title={`Return windows (${returns.length})`} />
              <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
                {returns.map((e, i) => (
                  <View key={`${e.receiptId}-${e.lineItemId ?? i}`}>
                    {i > 0 ? <View style={{ height: 1, backgroundColor: t.colors.border }} /> : null}
                    {renderRow(e)}
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {warranties.length > 0 ? (
            <>
              <SectionHeader title={`Warranties (${warranties.length})`} />
              <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
                {warranties.map((e, i) => (
                  <View key={`${e.receiptId}-${e.lineItemId ?? i}`}>
                    {i > 0 ? <View style={{ height: 1, backgroundColor: t.colors.border }} /> : null}
                    {renderRow(e)}
                  </View>
                ))}
              </Card>
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}
