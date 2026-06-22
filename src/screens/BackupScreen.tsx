/**
 * Backup & Restore — push the local SQLite database AND receipt images to the
 * USER'S OWN cloud (Google Drive or OneDrive) via OAuth, and pull them back.
 * There is NO ReceiptSnap server in this flow: we never see or store the user's
 * receipts on our infrastructure. Both providers expose a "Backup now" +
 * "Restore" pair, and we surface the last successful backup (provider +
 * timestamp) at the top.
 *
 * Gating: creating a backup is part of the one-time purchase ("cloud backup"
 * is a paid feature per spec). RESTORE is deliberately open to everyone — a
 * paying user reinstalling on a new device must be able to pull their data
 * back BEFORE re-validating the purchase with the store.
 */
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { router } from 'expo-router';
import {
  Screen,
  Card,
  Button,
  Text,
  Row,
  SectionHeader,
  Badge,
  Divider,
  Icon,
  LoadingOverlay,
  useTheme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import { backupNow, restoreFrom } from '@/services/backupService';
import { formatDate } from '@/lib/dates';
import type { CloudProvider } from '@/types';

/** Display metadata for each supported provider. */
const PROVIDERS: { id: CloudProvider; label: string; icon: 'logo-google' | 'cloud-outline' }[] = [
  { id: 'google_drive', label: 'Google Drive', icon: 'logo-google' },
  { id: 'onedrive', label: 'OneDrive', icon: 'cloud-outline' },
];

/** Human-readable label for a stored provider value. */
function providerLabel(provider: CloudProvider | null): string {
  if (provider === 'google_drive') return 'Google Drive';
  if (provider === 'onedrive') return 'OneDrive';
  return '—';
}

export default function BackupScreen() {
  const t = useTheme();
  const { settings, update } = useSettings();
  // `busy` holds the provider currently mid-operation so we can show the overlay
  // and disable both its buttons without blocking the other provider's card.
  const [busy, setBusy] = useState<CloudProvider | null>(null);
  // Live phase message from the service ("Backing up image 3 of 12…") shown in
  // the overlay while a multi-file backup/restore runs.
  const [progress, setProgress] = useState<string | null>(null);

  /** Run a backup; on success the service already persists last_backup_at, but
   *  we mirror the update here so the UI reflects it immediately. Cloud backup
   *  is gated behind the one-time purchase (restore is not — see handleRestore). */
  const handleBackup = async (provider: CloudProvider) => {
    if (!settings.is_unlocked) {
      Alert.alert(
        'Unlock required',
        'Cloud backup is included in the one-time ReceiptSnap unlock — no subscriptions, no ads.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Unlock', onPress: () => router.push('/paywall') },
        ],
      );
      return;
    }
    setBusy(provider);
    setProgress(null);
    try {
      const res = await backupNow(provider, setProgress);
      if (res.ok) {
        await update({ last_backup_at: new Date().toISOString(), backup_provider: provider });
      }
      Alert.alert(res.ok ? 'Backup complete' : 'Backup failed', res.message);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  /** Restore from the chosen provider; the local DB + images are replaced by
   *  the service (verified before the old data is discarded). Intentionally NOT
   *  gated: a paying user reinstalling must be able to restore first, and the
   *  restored database carries their `is_unlocked` entitlement back with it. */
  const handleRestore = (provider: CloudProvider) => {
    const label = providerLabel(provider);
    Alert.alert(
      `Restore from ${label}?`,
      'This replaces all data on this device with your latest cloud backup (database + receipt images). Your current data is kept until the downloaded backup is verified.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          style: 'destructive',
          onPress: async () => {
            setBusy(provider);
            setProgress(null);
            try {
              const res = await restoreFrom(provider, setProgress);
              Alert.alert(res.ok ? 'Restore complete' : 'Restore failed', res.message);
            } finally {
              setBusy(null);
              setProgress(null);
            }
          },
        },
      ],
    );
  };

  return (
    <Screen scroll edges={['top']}>
      <Text variant="title">Backup &amp; Restore</Text>

      {/* Privacy explainer — this is the user's OWN cloud, never our servers. */}
      <Card style={{ marginTop: t.spacing.md, gap: t.spacing.sm }}>
        <Row gap={t.spacing.sm} align="flex-start">
          <Icon name="shield-checkmark-outline" color={t.colors.brand} />
          <View style={{ flex: 1 }}>
            <Text variant="subheading">Your data stays yours</Text>
            <Text variant="body" color={t.colors.textMuted} style={{ marginTop: 4 }}>
              Backups go straight to your OWN personal Google Drive or OneDrive over a secure
              sign-in. ReceiptSnap has no server and never stores, sees, or syncs your receipts —
              everything lives on this device and in your cloud, under your control.
            </Text>
          </View>
        </Row>
      </Card>

      {/* Last successful backup summary. */}
      <SectionHeader title="Last backup" />
      <Card>
        <Row justify="space-between" align="center">
          <View style={{ flex: 1 }}>
            <Text variant="body" weight="600">
              {settings.last_backup_at
                ? formatDate(settings.last_backup_at.slice(0, 10), settings.date_format)
                : 'No backups yet'}
            </Text>
            <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: 2 }}>
              Provider: {providerLabel(settings.backup_provider)}
            </Text>
          </View>
          {settings.last_backup_at ? (
            <Badge label="Backed up" icon="checkmark-circle" color={t.colors.success} />
          ) : (
            <Badge label="Never" icon="cloud-offline-outline" color={t.colors.textMuted} />
          )}
        </Row>
      </Card>

      {/* One card per provider with Backup now + Restore. */}
      <SectionHeader title="Providers" />
      {PROVIDERS.map((p) => (
        <Card key={p.id} style={{ marginBottom: t.spacing.md, gap: t.spacing.md }}>
          <Row gap={t.spacing.sm} align="center">
            <Icon name={p.icon} color={t.colors.brand} />
            <Text variant="subheading">{p.label}</Text>
          </Row>
          <Text variant="caption" color={t.colors.textMuted}>
            Sign in to your {p.label} account to upload or download a copy of your ReceiptSnap
            database and receipt images. Repeat backups only upload new or changed images.
          </Text>
          <Divider spacing={0} />
          <Row gap={t.spacing.md}>
            <Button
              title="Backup now"
              icon="cloud-upload-outline"
              variant="primary"
              style={{ flex: 1 }}
              loading={busy === p.id}
              disabled={busy !== null && busy !== p.id}
              onPress={() => handleBackup(p.id)}
            />
            <Button
              title="Restore"
              icon="cloud-download-outline"
              variant="secondary"
              style={{ flex: 1 }}
              disabled={busy !== null}
              onPress={() => handleRestore(p.id)}
            />
          </Row>
        </Card>
      ))}

      <LoadingOverlay
        visible={busy !== null}
        message={progress ?? `Working with ${providerLabel(busy)}…`}
      />
    </Screen>
  );
}
