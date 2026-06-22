/**
 * About — app identity, the competitor-beating feature list, privacy stance
 * (offline-first, no server receipt storage), and share-with-friends.
 */
import { View } from 'react-native';
import Constants from 'expo-constants';
import * as Sharing from 'expo-sharing';
import { Screen, Card, Text, Row, SectionHeader, ListRow, Button, useTheme, Icon } from '@/components/ui';

const FEATURES: { icon: any; title: string; desc: string }[] = [
  { icon: 'create-outline', title: 'Fully editable', desc: 'Every extracted field can be corrected — nothing is auto-finalized.' },
  { icon: 'calendar-outline', title: 'Smart date disambiguation', desc: 'Ambiguous dates are flagged so you choose the right one.' },
  { icon: 'pricetag-outline', title: 'Custom filenames', desc: 'Name saved images with your own token template.' },
  { icon: 'list-outline', title: 'Itemized everything', desc: 'Exports include every line item, memo and tag — not just totals.' },
  { icon: 'shield-checkmark-outline', title: 'Warranty & returns', desc: 'Get reminded before return windows and warranties expire.' },
  { icon: 'calculator-outline', title: 'Tax intelligence', desc: 'Auto-suggested tax categories + a Schedule C-style report.' },
  { icon: 'car-sport-outline', title: 'Mileage tracking', desc: 'GPS or manual trips flow into your reports.' },
  { icon: 'cloud-offline-outline', title: 'Offline-first & private', desc: 'Your receipts live on your device and your own cloud.' },
];

export default function AboutScreen() {
  const t = useTheme();
  const version = Constants.expoConfig?.version ?? '2.0.0';

  const share = async () => {
    if (await Sharing.isAvailableAsync()) {
      // Sharing a text invite; on platforms without a file, this is a no-op fallback.
      try {
        await Sharing.shareAsync('https://receiptsnap.app', {
          dialogTitle: 'Try ReceiptSnap — the receipt scanner that gets it right.',
        });
      } catch {
        /* ignore */
      }
    }
  };

  return (
    <Screen scroll>
      <View style={{ alignItems: 'center', marginVertical: t.spacing.lg }}>
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
          <Icon name="receipt" size={36} color="#fff" />
        </View>
        <Text variant="heading" style={{ marginTop: t.spacing.md }}>
          ReceiptSnap
        </Text>
        <Text variant="caption" color={t.colors.textMuted}>
          Version {version}
        </Text>
      </View>

      <SectionHeader title="Why ReceiptSnap" />
      <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
        {FEATURES.map((f, i) => (
          <View key={f.title}>
            {i > 0 ? <View style={{ height: 1, backgroundColor: t.colors.border }} /> : null}
            <ListRow icon={f.icon} title={f.title} subtitle={f.desc} />
          </View>
        ))}
      </Card>

      <SectionHeader title="Privacy" />
      <Card>
        <Text variant="body" color={t.colors.textMuted}>
          ReceiptSnap is offline-first. Your receipts and images are stored only on your device and,
          if you choose, in your own Google Drive or OneDrive. We never store your receipts on our
          servers — the only thing our proxy sees is the text/image of a single scan you ask it to
          read, and it keeps nothing.
        </Text>
      </Card>

      <View style={{ marginTop: t.spacing.lg }}>
        <Button title="Share with a friend" icon="share-social-outline" onPress={share} />
      </View>
    </Screen>
  );
}
