/**
 * QR / e-receipt scanner (TASK 68).
 *
 * Uses expo-camera's on-device barcode scanning (QR only). When a code is read:
 *   - OUR data-only payload (TASK 70) → import a new pending receipt directly.
 *   - OUR cloud-link payload (TASK 69) → open the linked cloud receipt.
 *   - a plain URL (e-receipt) → fetch it and run through the extract pipeline,
 *     landing on the editable Review screen (degrades gracefully when offline).
 *   - an EU fiscal-receipt code (RKSV / DSFinV-K, best-effort) → labelled, with
 *     the verification URL routed through extract when present.
 *
 * Reached from the Scan screen and Home. Nothing is auto-finalized — imported /
 * fetched receipts always land in the pending review flow.
 */
import { useRef, useState } from 'react';
import { Alert, Linking, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, Stack } from 'expo-router';
import {
  Screen,
  Button,
  Text,
  Row,
  IconButton,
  LoadingOverlay,
  EmptyState,
  useTheme,
} from '@/components/ui';
import { useDraft } from '@/store/draft';
import { classifyScannedQr, type ScannedQr } from '@/lib/receiptQr';
import {
  importScannedReceiptData,
  fetchAndExtractFromUrl,
} from '@/services/qrShareService';

const FISCAL_LABEL: Record<string, string> = {
  at_rksv: 'Austria (RKSV)',
  de_dsfinv_k: 'Germany (DSFinV-K)',
};

export default function QrScannerScreen() {
  const t = useTheme();
  const startFromExtraction = useDraft((s) => s.startFromExtraction);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState<string | null>(null);
  // Latch so a continuous stream of frames only triggers ONE handler.
  const handledRef = useRef(false);

  const handle = async (scanned: ScannedQr) => {
    switch (scanned.kind) {
      case 'data': {
        setBusy('Importing receipt…');
        try {
          const id = await importScannedReceiptData(scanned.payload);
          router.replace({ pathname: '/receipt/[id]', params: { id } });
        } catch {
          fail('Could not import the scanned receipt.');
        } finally {
          setBusy(null);
        }
        return;
      }
      case 'link': {
        setBusy(null);
        Alert.alert(
          'Shared receipt link',
          `${scanned.vendor ? `${scanned.vendor}\n\n` : ''}Open the full receipt from the sender's cloud?`,
          [
            { text: 'Cancel', style: 'cancel', onPress: rearm },
            {
              text: 'Open link',
              onPress: async () => {
                try {
                  await Linking.openURL(scanned.url);
                } catch {
                  Alert.alert('Open link', 'Could not open the link.');
                }
                rearm();
              },
            },
          ],
        );
        return;
      }
      case 'url': {
        await routeUrl(scanned.url);
        return;
      }
      case 'fiscal': {
        setBusy(null);
        const label = FISCAL_LABEL[scanned.region] ?? 'EU fiscal receipt';
        Alert.alert(
          'EU fiscal receipt',
          `Detected a ${label} code (best-effort). ${
            scanned.url
              ? 'We can fetch its verification page and extract what we can.'
              : 'Full parsing of this signed format is not supported — scan the paper receipt as a photo for best accuracy.'
          }`,
          scanned.url
            ? [
                { text: 'Cancel', style: 'cancel', onPress: rearm },
                { text: 'Fetch & extract', onPress: () => routeUrl(scanned.url as string) },
              ]
            : [{ text: 'OK', onPress: rearm }],
        );
        return;
      }
      default:
        setBusy(null);
        Alert.alert(
          'Unrecognized code',
          'This QR is not a ReceiptSnap receipt or an e-receipt link.',
          [{ text: 'OK', onPress: rearm }],
        );
    }
  };

  /** Fetch an e-receipt URL → extract → editable Review. */
  const routeUrl = async (url: string) => {
    setBusy('Fetching e-receipt…');
    try {
      const extraction = await fetchAndExtractFromUrl(url);
      if (!extraction) {
        fail("Couldn't read that e-receipt. Try scanning the paper receipt as a photo.");
        return;
      }
      startFromExtraction(extraction, {
        imageUris: [],
        originalImageUri: null,
        source: 'email',
        imageFormat: 'jpg',
      });
      router.replace('/review');
    } catch {
      fail('Something went wrong fetching that e-receipt.');
    } finally {
      setBusy(null);
    }
  };

  /** Re-arm the scanner after a dismissed prompt so the user can try again. */
  const rearm = () => {
    handledRef.current = false;
  };

  const fail = (message: string) => {
    Alert.alert('Scan', message, [{ text: 'OK', onPress: rearm }]);
  };

  const onBarcode = (data: string) => {
    if (handledRef.current) return;
    handledRef.current = true;
    handle(classifyScannedQr(data));
  };

  // Permission gate.
  if (!permission) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Scan QR' }} />
        <LoadingOverlay visible message="Preparing camera…" />
      </Screen>
    );
  }
  if (!permission.granted) {
    return (
      <Screen scroll>
        <Stack.Screen options={{ title: 'Scan QR' }} />
        <EmptyState
          icon="qr-code-outline"
          title="Camera access needed"
          message="Allow camera access to scan receipt QR codes and e-receipt links."
          action="Grant access"
          onAction={requestPermission}
        />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Stack.Screen options={{ headerShown: false }} />
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => onBarcode(data)}
      />

      <View style={{ position: 'absolute', top: 48, left: 16 }}>
        <IconButton icon="close" color="#fff" onPress={() => router.back()} accessibilityLabel="Close scanner" />
      </View>

      {/* Aiming frame. */}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            width: 240,
            height: 240,
            borderRadius: t.radius.lg,
            borderWidth: 3,
            borderColor: 'rgba(255,255,255,0.85)',
          }}
        />
      </View>

      <View style={{ position: 'absolute', bottom: 56, width: '100%', alignItems: 'center', paddingHorizontal: 24, gap: 12 }}>
        <Text color="#fff" variant="subheading" align="center">
          Point at a receipt QR or e-receipt link
        </Text>
        <Row gap={t.spacing.md}>
          <Button title="Rescan" icon="refresh" variant="secondary" onPress={rearm} />
        </Row>
      </View>

      <LoadingOverlay visible={!!busy} message={busy ?? ''} />
    </View>
  );
}
