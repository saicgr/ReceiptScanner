/**
 * Onboarding — a few slides that sell the reasons to KEEP the app installed
 * (warranty/return reminders + tax intelligence, per the V2 spec). Finishing
 * marks onboarding_complete and requests notification permission.
 */
import { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { Screen, Text, Button, Row, Icon, useTheme } from '@/components/ui';
import { useSettings } from '@/store/settings';
import { ensurePermissions } from '@/services/notificationsService';

interface Slide {
  icon: any;
  title: string;
  body: string;
  color: string;
}

export default function OnboardingScreen() {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const update = useSettings((s) => s.update);
  const [i, setI] = useState(0);

  const slides: Slide[] = [
    {
      icon: 'scan',
      title: 'Scan with confidence',
      body: 'Capture, import or forward receipts. AI extracts the details — and every field stays fully editable. Ambiguous dates are flagged so you pick the right one.',
      color: t.colors.brand,
    },
    {
      icon: 'shield-checkmark',
      title: 'Never miss a return or warranty',
      body: 'ReceiptSnap learns each purchase’s return window and warranty, then reminds you a few days before they expire — so you can actually claim them.',
      color: t.colors.info,
    },
    {
      icon: 'calculator',
      title: 'Tax time, sorted',
      body: 'Expenses are auto-tagged with likely tax categories and deductibility. Generate a Schedule C-style report in seconds, itemized and export-ready.',
      color: t.colors.success,
    },
    {
      icon: 'cloud-offline',
      title: 'Yours, and private',
      body: 'Offline-first. Your receipts live on your device and your own cloud backup — never on our servers. One-time purchase, no subscriptions, no ads.',
      color: t.colors.warning,
    },
  ];

  const last = i === slides.length - 1;
  const slide = slides[i];

  const finish = async () => {
    await update({ onboarding_complete: true, warranty_tax_hint_seen: true });
    ensurePermissions().catch(() => {});
    router.back();
  };

  return (
    <Screen padded edges={['top', 'bottom']}>
      <Row justify="flex-end">
        <Button title="Skip" variant="ghost" size="sm" onPress={finish} />
      </Row>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.spacing.xl }}>
        <View
          style={{
            width: 120,
            height: 120,
            borderRadius: 60,
            backgroundColor: slide.color + '22',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={slide.icon} size={56} color={slide.color} />
        </View>
        <Text variant="title" align="center">
          {slide.title}
        </Text>
        <Text variant="body" align="center" color={t.colors.textMuted} style={{ paddingHorizontal: t.spacing.md }}>
          {slide.body}
        </Text>
      </View>

      <Row justify="center" gap={8} style={{ marginBottom: t.spacing.xl }}>
        {slides.map((_, idx) => (
          <View
            key={idx}
            style={{
              width: idx === i ? 22 : 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: idx === i ? t.colors.brand : t.colors.border,
            }}
          />
        ))}
      </Row>

      <Button
        title={last ? 'Get started' : 'Next'}
        size="lg"
        icon={last ? 'checkmark' : 'arrow-forward'}
        onPress={() => (last ? finish() : setI(i + 1))}
      />
    </Screen>
  );
}
