/**
 * Share-via-QR screen (TASKS 70 + 69).
 *
 * Two modes, chosen with a segmented control:
 *   - "Data" (TASK 70): a compact, image-free QR of the receipt's core fields.
 *     Another ReceiptSnap install scans it to import the receipt for review. If
 *     the payload is too big for a QR, we DON'T draw a broken code — we offer a
 *     data-file export instead.
 *   - "Link" (TASK 69): a QR encoding a cloud share LINK to the full receipt
 *     (incl. image). Requires the receipt to be backed up first (we host
 *     nothing); the user pastes the share link from their own Drive/OneDrive.
 *
 * All money shown via formatMoney. Reached from the receipt detail.
 */
import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  Screen,
  Card,
  Button,
  Text,
  Row,
  Divider,
  SegmentedControl,
  TextField,
  IconButton,
  EmptyState,
  LoadingOverlay,
  useTheme,
} from '@/components/ui';
import { QrCode } from '@/components/QrCode';
import * as DB from '@/db';
import { formatMoney } from '@/lib/money';
import {
  prepareReceiptDataShare,
  prepareReceiptLinkShare,
  shareDataFile,
  type DataShareResult,
} from '@/services/qrShareService';
import type { ReceiptWithRelations } from '@/types';

type Mode = 'data' | 'link';

export default function ShareQrScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [receipt, setReceipt] = useState<ReceiptWithRelations | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('data');
  const [busy, setBusy] = useState(false);

  const [dataShare, setDataShare] = useState<DataShareResult | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [linkQr, setLinkQr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setLoaded(true);
      return;
    }
    const r = await DB.getReceipt(id);
    setReceipt(r);
    setLoaded(true);
    if (r) {
      try {
        setDataShare(await prepareReceiptDataShare(r));
      } catch {
        setDataShare(null);
      }
    }
  }, [id]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loaded && !receipt) {
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'Share via QR' }} />
        <EmptyState icon="qr-code-outline" title="Receipt not found" message="It may have been deleted." action="Back" onAction={() => router.back()} />
      </Screen>
    );
  }
  if (!receipt) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Share via QR' }} />
        <LoadingOverlay visible message="Loading…" />
      </Screen>
    );
  }

  const r = receipt;

  const onShareFile = async () => {
    if (dataShare?.mode !== 'file') return;
    setBusy(true);
    try {
      await shareDataFile(dataShare.fileUri);
    } finally {
      setBusy(false);
    }
  };

  const onMakeLink = () => {
    const result = prepareReceiptLinkShare(r, linkInput);
    if (result.ok) {
      setLinkQr(result.text);
      return;
    }
    setLinkQr(null);
    if (result.reason === 'not_backed_up') {
      Alert.alert('Back up first', result.message, [
        { text: 'Not now', style: 'cancel' },
        { text: 'Back up', onPress: () => router.push('/settings/backup') },
      ]);
    } else {
      Alert.alert('Cloud link', result.message);
    }
  };

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Share via QR' }} />

      <Row align="center" gap={t.spacing.sm} style={{ marginBottom: t.spacing.md }}>
        <IconButton icon="chevron-back" size={24} onPress={() => router.back()} accessibilityLabel="Back" />
        <Text variant="title">Share via QR</Text>
      </Row>

      <Card style={{ marginBottom: t.spacing.lg }}>
        <Text variant="subheading">{r.vendor || 'Untitled receipt'}</Text>
        <Text variant="body" color={t.colors.textMuted}>
          {formatMoney(r.total, r.currency)}
          {r.line_items.length ? ` · ${r.line_items.length} item${r.line_items.length === 1 ? '' : 's'}` : ''}
        </Text>
      </Card>

      <SegmentedControl<Mode>
        options={[
          { label: 'Data QR', value: 'data' },
          { label: 'Cloud link', value: 'link' },
        ]}
        value={mode}
        onChange={setMode}
      />

      {mode === 'data' ? (
        <View style={{ marginTop: t.spacing.lg }}>
          {dataShare?.mode === 'qr' ? (
            <>
              <Card style={{ alignItems: 'center', paddingVertical: t.spacing.xl }}>
                <QrCode value={dataShare.text} size={260} />
                <Text variant="caption" color={t.colors.textMuted} align="center" style={{ marginTop: t.spacing.md }}>
                  Scan with another ReceiptSnap to import this receipt for review.
                  The image is not included.
                </Text>
                <Text variant="caption" color={t.colors.textFaint} align="center" style={{ marginTop: 4 }}>
                  {dataShare.byteLength} bytes
                </Text>
              </Card>
            </>
          ) : dataShare?.mode === 'file' ? (
            <Card>
              <Text variant="subheading">Too big for a QR</Text>
              <Text variant="body" color={t.colors.textMuted} style={{ marginTop: 6 }}>
                This receipt has too many line items to fit in a single QR
                ({dataShare.byteLength} bytes, max {dataShare.cap}). Share it as a
                data file instead — another ReceiptSnap can import it the same way.
              </Text>
              <Divider />
              <Button title="Share data file" icon="share-outline" onPress={onShareFile} />
            </Card>
          ) : (
            <Card>
              <Text variant="body" color={t.colors.textMuted}>Preparing…</Text>
            </Card>
          )}
        </View>
      ) : (
        <View style={{ marginTop: t.spacing.lg }}>
          <Card>
            <Text variant="body" color={t.colors.textMuted} style={{ marginBottom: t.spacing.md }}>
              A cloud link shares the FULL receipt incl. its image. Back the
              receipt up to your own Drive/OneDrive, then paste the share link
              here — we host nothing.
            </Text>
            <TextField
              label="Cloud share link"
              value={linkInput}
              onChangeText={setLinkInput}
              placeholder="https://…"
            />
            <Button title="Generate link QR" icon="qr-code-outline" onPress={onMakeLink} />
          </Card>

          {linkQr ? (
            <Card style={{ alignItems: 'center', paddingVertical: t.spacing.xl, marginTop: t.spacing.lg }}>
              <QrCode value={linkQr} size={260} />
              <Text variant="caption" color={t.colors.textMuted} align="center" style={{ marginTop: t.spacing.md }}>
                Scan to open the full receipt from your cloud.
              </Text>
            </Card>
          ) : null}
        </View>
      )}

      <LoadingOverlay visible={busy} message="Working…" />
    </Screen>
  );
}
