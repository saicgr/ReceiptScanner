/**
 * Home — the "ledger". A full-bleed emerald hero leads with the month's total in
 * Fraunces numerals, Quick/Multi scan CTAs, then stat tiles, the email-forwarding
 * card and recent receipts. All data logic is unchanged from the original; this
 * is the VAULT visual rebuild. First launch pushes onboarding.
 */
import { useCallback, useState } from 'react';
import { View, ScrollView, Pressable, Text as RNText } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import {
  Text,
  Row,
  SectionHeader,
  Badge,
  EmptyState,
  GradientHero,
  StatTile,
  Monogram,
  useTheme,
} from '@/components/ui';
import { fonts } from '@/theme';
import { useSettings } from '@/store/settings';
import * as DB from '@/db';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import { fetchForwardingAddress, importPendingReceipts } from '@/services/emailIngestService';
import { useDraft } from '@/store/draft';
import type { Receipt, CurrencyTotal } from '@/types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function HomeScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { settings, scansRemaining } = useSettings();
  const [recent, setRecent] = useState<Receipt[]>([]);
  const [count, setCount] = useState(0);
  const [monthTotals, setMonthTotals] = useState<CurrencyTotal[]>([]);
  const [address, setAddress] = useState<string>(settings.forwarding_address);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const [list, n] = await Promise.all([
      DB.listReceipts({ orderBy: 'created_desc', limit: 5 }),
      DB.countReceipts(),
    ]);
    setRecent(list);
    setCount(n);
    const start = new Date();
    const monthStart = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
    setMonthTotals(await DB.totalsByCurrency({ startDate: monthStart }));
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!settings.onboarding_complete) {
        router.push('/onboarding');
      }
      load();
      if (!address) {
        fetchForwardingAddress()
          .then((r) => setAddress(r.address))
          .catch(() => {});
      }
    }, [load, settings.onboarding_complete, address]),
  );

  const remaining = scansRemaining();
  const primary = monthTotals[0] ?? { currency: settings.default_currency, total: 0 };
  const extra = monthTotals.slice(1, 3);

  const checkInbox = async () => {
    setChecking(true);
    try {
      const imported = await importPendingReceipts();
      if (imported.length === 0) return;
      await load();
      const first = await DB.getReceipt(imported[0]);
      if (first) {
        useDraft.getState().startFromReceipt(first);
        router.push('/review');
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
      >
        {/* ---------------- HERO ---------------- */}
        <GradientHero style={{ paddingTop: insets.top + 18, paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xxxl + t.spacing.lg }}>
          <Row justify="space-between" align="center" style={{ marginBottom: t.spacing.xl }}>
            <Row gap={11} align="center">
              <LinearGradient
                colors={['#F3E2B0', '#C2954A']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }}
              >
                <Ionicons name="receipt" size={20} color="#08311F" />
              </LinearGradient>
              <View>
                <RNHero>ReceiptSnap</RNHero>
                <Text variant="caption" color={t.colors.onHeroMuted} style={{ letterSpacing: 2.5, fontFamily: fonts.sansBold, marginTop: 1 }}>
                  VAULT
                </Text>
              </View>
            </Row>
            <Pressable
              onPress={() => router.push('/settings')}
              hitSlop={10}
              style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)' }}
            >
              <Ionicons name="settings-outline" size={20} color={t.colors.onHero} />
            </Pressable>
          </Row>

          <Text variant="label" color={t.colors.onHeroMuted} style={{ letterSpacing: 2.4, fontFamily: fonts.sansBold }}>
            THIS MONTH · {MONTHS[new Date().getMonth()].toUpperCase()}
          </Text>
          <Text style={{ fontFamily: fonts.displayMedium, fontSize: 58, color: t.colors.onHero, letterSpacing: -1.5, marginTop: 6 }}>
            {formatMoney(primary.total, primary.currency)}
          </Text>
          <Row gap={8} align="center" style={{ marginTop: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(243,226,176,0.92)', paddingVertical: 5, paddingHorizontal: 11, borderRadius: 999 }}>
              <Ionicons name="receipt-outline" size={13} color="#08311F" />
              <RNText style={{ color: '#08311F', fontFamily: fonts.sansBold, fontSize: 12.5 }}>
                {count} receipt{count === 1 ? '' : 's'}
              </RNText>
            </View>
            <RNText style={{ color: t.colors.onHeroMuted, fontFamily: fonts.sansSemibold, fontSize: 12.5 }}>
              {settings.is_unlocked ? 'Unlimited · Pro' : `${remaining} free scan${remaining === 1 ? '' : 's'} left`}
            </RNText>
          </Row>
          {extra.length > 0 ? (
            <Row gap={t.spacing.md} style={{ marginTop: 6 }}>
              {extra.map((m) => (
                <RNText key={m.currency} style={{ color: t.colors.onHeroMuted, fontFamily: fonts.displayMedium, fontSize: 15 }}>
                  + {formatMoney(m.total, m.currency)}
                </RNText>
              ))}
            </Row>
          ) : null}

          {/* scan CTAs */}
          <Row gap={t.spacing.md} align="stretch" style={{ marginTop: t.spacing.xl }}>
            <ScanCard
              tone="gold"
              icon="scan"
              title="Quick Scan"
              subtitle="One receipt, instant capture"
              onPress={() => router.push('/scan')}
            />
            <ScanCard
              tone="glass"
              icon="copy-outline"
              title="Multi Scan"
              subtitle="Batch & long receipts"
              onPress={() => router.push('/multi-scan')}
            />
          </Row>
        </GradientHero>

        {/* ---------------- BODY ---------------- */}
        <View style={{ paddingHorizontal: t.spacing.lg, marginTop: -t.spacing.xxl }}>
          <Row gap={t.spacing.md} align="stretch">
            <StatTile label="Receipts" value={String(count)} sub={count > 0 ? 'all time' : 'none yet'} subTone="muted" />
            <StatTile
              label={settings.is_unlocked ? 'Plan' : 'Scans left'}
              value={settings.is_unlocked ? 'Pro' : String(remaining)}
              sub={settings.is_unlocked ? 'unlimited' : 'of 25 free'}
              subTone="muted"
            />
          </Row>

          {/* Email forwarding */}
          {address ? (
            <View style={{ marginTop: t.spacing.md, backgroundColor: t.colors.cardAlt, borderRadius: t.radius.lg, borderWidth: 1, borderColor: t.colors.border, padding: t.spacing.lg, overflow: 'hidden', ...t.shadow(1) }}>
              <Row justify="space-between" align="center">
                <Text variant="caption" color={t.colors.textFaint} style={{ letterSpacing: 1.4, fontFamily: fonts.sansBold }}>
                  FORWARD E-RECEIPTS TO
                </Text>
                <Badge label="Email-in" icon="mail" color={t.colors.gold} background={t.colors.goldTint} />
              </Row>
              <Text style={{ fontFamily: fonts.displayMedium, fontSize: 17, marginTop: 8, marginBottom: 13 }} numberOfLines={1}>
                {address}
              </Text>
              <Row gap={t.spacing.sm}>
                <PillAction icon="copy-outline" label="Copy address" onPress={() => Clipboard.setStringAsync(address)} />
                <PillAction icon="refresh" label="Check inbox" loading={checking} onPress={checkInbox} />
              </Row>
            </View>
          ) : null}

          {/* Recent */}
          <SectionHeader
            title="Recent receipts"
            action={count > 0 ? 'View all' : undefined}
            actionIcon="chevron-forward"
            onAction={() => router.push('/history')}
          />
          {recent.length === 0 ? (
            <EmptyState
              icon="scan-outline"
              title="No receipts yet"
              message="Tap Quick Scan to capture your first receipt."
            />
          ) : (
            <View style={{ gap: t.spacing.sm }}>
              {recent.map((r) => (
                <Pressable
                  key={r.id}
                  onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: r.id } })}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: t.spacing.md,
                    backgroundColor: t.colors.card,
                    borderRadius: t.radius.lg,
                    borderWidth: 1,
                    borderColor: t.colors.border,
                    padding: t.spacing.md,
                    opacity: pressed ? 0.9 : 1,
                    ...t.shadow(1),
                  })}
                >
                  <Monogram name={r.vendor || 'Untitled'} />
                  <View style={{ flex: 1 }}>
                    <RNText style={{ color: t.colors.text, fontFamily: fonts.sansBold, fontSize: t.fontSize.md }} numberOfLines={1}>
                      {r.vendor || 'Untitled receipt'}
                    </RNText>
                    <Row gap={8} align="center" style={{ marginTop: 4 }}>
                      <RNText style={{ color: t.colors.textFaint, fontFamily: fonts.sansSemibold, fontSize: t.fontSize.sm }}>
                        {formatDate(r.date, settings.date_format)}
                      </RNText>
                      {r.status === 'pending' ? (
                        <View style={{ backgroundColor: t.colors.goldTint, paddingVertical: 1, paddingHorizontal: 7, borderRadius: 999 }}>
                          <RNText style={{ color: t.colors.gold, fontFamily: fonts.sansBold, fontSize: 10.5 }}>Pending</RNText>
                        </View>
                      ) : null}
                    </Row>
                  </View>
                  <RNText style={{ color: t.colors.text, fontFamily: fonts.display, fontSize: 18 }}>
                    {formatMoney(r.total, r.currency)}
                  </RNText>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );

  // local helper for the wordmark in the hero (uses onHero colour + Fraunces)
  function RNHero({ children }: { children: React.ReactNode }) {
    return (
      <RNText style={{ color: t.colors.onHero, fontFamily: fonts.display, fontSize: 21, letterSpacing: -0.3 }}>
        {children}
      </RNText>
    );
  }
}

/** A scan CTA — gold gradient (primary) or frosted glass (secondary). */
function ScanCard({
  tone,
  icon,
  title,
  subtitle,
  onPress,
}: {
  tone: 'gold' | 'glass';
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const fgGold = '#08311F';
  const body = (
    <View style={{ gap: 14 }}>
      <View style={{ width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: tone === 'gold' ? 'rgba(8,49,31,0.12)' : 'rgba(255,255,255,0.14)' }}>
        <Ionicons name={icon} size={20} color={tone === 'gold' ? fgGold : t.colors.onHero} />
      </View>
      <View>
        <RNText style={{ color: tone === 'gold' ? fgGold : t.colors.onHero, fontFamily: fonts.sansExtra, fontSize: 16 }}>{title}</RNText>
        <RNText style={{ color: tone === 'gold' ? 'rgba(8,49,31,0.72)' : t.colors.onHeroMuted, fontFamily: fonts.sansMedium, fontSize: 11.5, marginTop: 2 }}>
          {subtitle}
        </RNText>
      </View>
    </View>
  );
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ flex: 1, ...(pressed ? { transform: [{ scale: 0.98 }] } : null) })}>
      {tone === 'gold' ? (
        <LinearGradient colors={['#F6E7B8', '#D9B25C']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: t.radius.lg, padding: t.spacing.lg, ...t.shadow(2) }}>
          {body}
        </LinearGradient>
      ) : (
        <View style={{ flex: 1, borderRadius: t.radius.lg, padding: t.spacing.lg, backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' }}>
          {body}
        </View>
      )}
    </Pressable>
  );
}

/** Small emerald-tinted pill action used on the forwarding card. */
function PillAction({
  icon,
  label,
  loading,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  loading?: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        backgroundColor: t.colors.brandTint,
        paddingVertical: 9,
        paddingHorizontal: 14,
        borderRadius: t.radius.md,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Ionicons name={loading ? 'sync' : icon} size={15} color={t.colors.brand} />
      <RNText style={{ color: t.colors.brand, fontFamily: fonts.sansBold, fontSize: 13 }}>{label}</RNText>
    </Pressable>
  );
}
