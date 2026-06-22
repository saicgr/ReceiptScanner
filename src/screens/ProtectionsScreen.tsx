/**
 * Protections (V2 headline) — active return windows and warranties, soonest
 * first, so users actually claim them before they lapse. Built from receipt-
 * and item-level deadlines by protectionsService.
 */
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  Screen,
  Card,
  Text,
  Row,
  Badge,
  SectionHeader,
  ListRow,
  EmptyState,
  useTheme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import { listProtections } from '@/services/protectionsService';
import { formatDate, relativeDays } from '@/lib/dates';
import type { ProtectionEntry } from '@/types';

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
  const [loaded, setLoaded] = useState(false);

  useFocusEffect(
    useCallback(() => {
      listProtections()
        .then(setEntries)
        .finally(() => setLoaded(true));
    }, []),
  );

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
