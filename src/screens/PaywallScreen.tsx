/**
 * Paywall — a single one-time purchase ($9.99) unlocking unlimited scans, all
 * exports and cloud backup. No subscriptions, no ads (the whole point).
 */
import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { router } from 'expo-router';
import { Screen, Card, Button, Text, Row, Icon, useTheme } from '@/components/ui';
import { appConfig } from '@/lib/config';
import { getProducts, purchaseUnlock, restorePurchases } from '@/services/billingService';
import { useSettings } from '@/store/settings';

const BENEFITS: { icon: any; title: string; desc: string }[] = [
  { icon: 'infinite', title: 'Unlimited receipts', desc: 'Scan as many as you need — forever.' },
  { icon: 'download-outline', title: 'All exports', desc: 'CSV, Excel, PDF + QuickBooks, Xero & Wave — itemized.' },
  { icon: 'cloud-upload-outline', title: 'Your-cloud backup', desc: 'Back up & restore via your own Google Drive / OneDrive.' },
  { icon: 'shield-checkmark-outline', title: 'Warranty & tax tools', desc: 'Reminders and Schedule C-style reports, unlimited.' },
];

export default function PaywallScreen() {
  const t = useTheme();
  const { settings } = useSettings();
  const [price, setPrice] = useState(appConfig.iapPriceLabel);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getProducts()
      .then((p) => {
        if (p[0]?.price) setPrice(p[0].price);
      })
      .catch(() => {});
  }, []);

  if (settings.is_unlocked) {
    return (
      <Screen>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.spacing.lg }}>
          <Icon name="checkmark-circle" size={64} color={t.colors.success} />
          <Text variant="heading">You’re unlocked</Text>
          <Text color={t.colors.textMuted}>Thanks for supporting ReceiptSnap.</Text>
          <Button title="Done" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  const buy = async () => {
    setBusy(true);
    const r = await purchaseUnlock();
    setBusy(false);
    if (r.ok) {
      Alert.alert('Unlocked', 'Enjoy unlimited ReceiptSnap.');
      router.back();
    } else {
      Alert.alert('Purchase', r.message);
    }
  };

  const restore = async () => {
    setBusy(true);
    const r = await restorePurchases();
    setBusy(false);
    Alert.alert('Restore', r.message);
    if (r.ok) router.back();
  };

  return (
    <Screen scroll>
      <View style={{ alignItems: 'center', marginVertical: t.spacing.xl }}>
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            backgroundColor: t.colors.brand,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="rocket" size={36} color="#fff" />
        </View>
        <Text variant="title" style={{ marginTop: t.spacing.md }}>
          Unlock ReceiptSnap
        </Text>
        <Text color={t.colors.textMuted} align="center">
          One payment. Yours forever.
        </Text>
      </View>

      <Card padded={false} style={{ paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm }}>
        {BENEFITS.map((b, i) => (
          <Row key={b.title} gap={t.spacing.md} style={{ paddingVertical: t.spacing.md }}>
            <Icon name={b.icon} size={24} color={t.colors.brand} />
            <View style={{ flex: 1 }}>
              <Text variant="subheading">{b.title}</Text>
              <Text variant="caption" color={t.colors.textMuted}>
                {b.desc}
              </Text>
            </View>
            {i < BENEFITS.length ? null : null}
          </Row>
        ))}
      </Card>

      <View style={{ marginTop: t.spacing.xl }}>
        <Button title={`Unlock · ${price}`} size="lg" loading={busy} onPress={buy} />
        <Button title="Restore purchases" variant="ghost" onPress={restore} style={{ marginTop: t.spacing.sm }} />
      </View>

      <Text variant="caption" color={t.colors.textMuted} align="center" style={{ marginTop: t.spacing.md }}>
        One-time payment · No subscription · No ads
      </Text>
    </Screen>
  );
}
