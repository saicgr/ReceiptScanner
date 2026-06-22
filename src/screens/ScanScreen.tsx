/**
 * Quick Scan — capture ONE receipt via camera, gallery, or PDF import.
 *
 * Image pipeline (camera/gallery): enhance -> (on-device OCR ∥ base64 encode, in
 * PARALLEL) -> /extract (Gemini) -> editable draft -> dup check -> Review.
 * PDF pipeline: skip enhance/OCR (those are image-only) and send the PDF bytes
 * straight to Gemini as application/pdf, which reads every page.
 * EXIF capture-time/GPS from imports is attached and used as a date fallback.
 */
import { useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import {
  Screen,
  Card,
  Button,
  Text,
  Row,
  IconButton,
  LoadingOverlay,
  EmptyState,
  useTheme,
  Icon,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import { useDraft } from '@/store/draft';
import {
  importPdf,
  pickReceiptsWithMeta,
  parseAssetMeta,
  toBase64,
} from '@/services/imagePipeline';
import { processImage } from '@/services/batchService';
import { detectReceiptRegions } from '@/services/receiptDetect';
import { extractReceipt } from '@/services/extractClient';
import { checkDuplicate } from '@/services/receiptService';
import type { ImageMeta } from '@/types';

export default function ScanScreen() {
  const t = useTheme();
  const { settings, canScan } = useSettings();
  const startFromExtraction = useDraft((s) => s.startFromExtraction);
  const setDuplicate = useDraft((s) => s.setDuplicate);

  const [cameraOpen, setCameraOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);

  const gate = (): boolean => {
    if (!canScan()) {
      router.replace('/paywall');
      return false;
    }
    return true;
  };

  /** Attach EXIF capture metadata + use capture-time as a date fallback. */
  const applyMeta = (meta: ImageMeta | null) => {
    if (!meta) return;
    const d = useDraft.getState();
    const patch: Record<string, unknown> = {
      captured_at: meta.capturedAt,
      captured_lat: meta.lat,
      captured_lng: meta.lng,
    };
    // If the model couldn't read a date, fall back to when the photo was taken.
    if (!d.date && meta.capturedAt) {
      patch.date = meta.capturedAt.slice(0, 10);
      patch.date_options = [meta.capturedAt.slice(0, 10)];
    }
    d.patch(patch);
  };

  /**
   * If a single photo turns out to contain MULTIPLE receipts, offer to divert to
   * the on-device split-review flow. Detection is on-device (free). Returns true
   * when it routed away (so the caller skips the single-receipt path).
   */
  const maybeSplit = async (uri: string): Promise<boolean> => {
    try {
      setBusy('Checking for multiple receipts…');
      const regions = await detectReceiptRegions(uri);
      if (regions.length > 1) {
        setBusy(null);
        return await new Promise<boolean>((resolve) => {
          Alert.alert(
            'Multiple receipts detected',
            `We found ${regions.length} receipts in this photo. Split them into separate entries?`,
            [
              { text: 'Scan as one', style: 'cancel', onPress: () => resolve(false) },
              {
                text: `Split into ${regions.length}`,
                onPress: () => {
                  router.replace({
                    pathname: '/split-review',
                    params: { uris: JSON.stringify([uri]) },
                  });
                  resolve(true);
                },
              },
            ],
            // Android back / tap-outside dismisses the alert without pressing a
            // button — fall through to the single-receipt flow so the captured
            // photo is never silently dropped. (Double-resolve is harmless.)
            { cancelable: true, onDismiss: () => resolve(false) },
          );
        });
      }
    } catch {
      // Detection unavailable/failed — fall through to the single-receipt flow.
    }
    return false;
  };

  /** Image pipeline (camera/gallery): enhance ∥ OCR+encode -> extract -> review. */
  const process = async (
    uri: string,
    source: 'camera' | 'gallery',
    meta: ImageMeta | null,
  ) => {
    setBusy('Reading & extracting…');
    try {
      const { uri: enhanced, extraction } = await processImage(uri, {
        autoCrop: settings.auto_crop,
      });
      startFromExtraction(extraction, {
        imageUris: [enhanced],
        originalImageUri: uri, // ALWAYS keep the full original
        source,
        imageFormat: settings.image_format,
      });
      applyMeta(meta);
      const dup = await checkDuplicate();
      if (dup) setDuplicate(dup.id, dup.score);
      router.replace('/review');
    } catch {
      // The photo is still in `uri` — offer a retry instead of dropping it.
      Alert.alert('Scan failed', 'Something went wrong while reading this receipt.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Retry', onPress: () => process(uri, source, meta) },
      ]);
    } finally {
      setBusy(null); // never leave the overlay stuck on an error
    }
  };

  /** PDF pipeline: send the PDF straight to Gemini (no enhance/OCR). */
  const processPdf = async (uri: string) => {
    setBusy('Extracting from PDF…');
    try {
      const base64 = await toBase64(uri);
      const extraction = await extractReceipt({
        imageBase64: base64,
        imageMimeType: 'application/pdf',
      });
      startFromExtraction(extraction, {
        imageUris: [uri],
        originalImageUri: uri,
        source: 'pdf',
        imageFormat: settings.image_format,
      });
      const dup = await checkDuplicate();
      if (dup) setDuplicate(dup.id, dup.score);
      router.replace('/review');
    } catch {
      Alert.alert('Import failed', 'Something went wrong while reading this PDF.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Retry', onPress: () => processPdf(uri) },
      ]);
    } finally {
      setBusy(null); // never leave the overlay stuck on an error
    }
  };

  const onCapture = async () => {
    if (!cameraRef.current) return;
    const photo = await cameraRef.current.takePictureAsync({ quality: 0.8, exif: true });
    setCameraOpen(false);
    if (photo?.uri) {
      const meta = parseAssetMeta({ uri: photo.uri, width: photo.width, height: photo.height, exif: photo.exif });
      if (await maybeSplit(photo.uri)) return;
      await process(photo.uri, 'camera', meta);
    }
  };

  const onGallery = async () => {
    if (!gate()) return;
    const picked = await pickReceiptsWithMeta();
    if (picked.length) {
      if (await maybeSplit(picked[0].uri)) return;
      await process(picked[0].uri, 'gallery', picked[0].meta);
    }
  };

  const onPdf = async () => {
    if (!gate()) return;
    const res = await importPdf();
    if (res) await processPdf(res.pageUris[0] ?? res.uri);
  };

  const openCamera = async () => {
    if (!gate()) return;
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) return;
    }
    setCameraOpen(true);
  };

  if (cameraOpen) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView ref={cameraRef} style={{ flex: 1 }} facing="back" />
        <View style={{ position: 'absolute', top: 48, left: 16 }}>
          <IconButton icon="close" color="#fff" onPress={() => setCameraOpen(false)} />
        </View>
        <View style={{ position: 'absolute', bottom: 48, width: '100%', alignItems: 'center' }}>
          <IconButton
            icon="ellipse"
            size={64}
            color="#fff"
            onPress={onCapture}
            accessibilityLabel="Capture"
          />
          <Text color="#fff" variant="caption">
            Align the receipt and tap to capture
          </Text>
        </View>
      </View>
    );
  }

  return (
    <Screen scroll>
      <LoadingOverlay visible={!!busy} message={busy ?? ''} />

      <Card onPress={openCamera} style={{ alignItems: 'center', paddingVertical: t.spacing.xxl }}>
        <Icon name="camera" size={48} color={t.colors.brand} />
        <Text variant="subheading" style={{ marginTop: t.spacing.md }}>
          Take a photo
        </Text>
        <Text variant="caption" color={t.colors.textMuted}>
          Auto-cropped & enhanced on-device
        </Text>
      </Card>

      <Row gap={t.spacing.md} style={{ marginTop: t.spacing.lg }}>
        <Button title="Gallery" icon="images-outline" variant="secondary" style={{ flex: 1 }} onPress={onGallery} />
        <Button title="Import PDF" icon="document-outline" variant="secondary" style={{ flex: 1 }} onPress={onPdf} />
      </Row>

      {!canScan() ? (
        <EmptyState
          icon="lock-closed-outline"
          title="Free scans used up"
          message="Unlock unlimited scans, exports and cloud backup with a one-time purchase."
          action="Unlock · $9.99"
          onAction={() => router.replace('/paywall')}
        />
      ) : (
        <Text variant="caption" color={t.colors.textMuted} align="center" style={{ marginTop: t.spacing.xl }}>
          The full original image is always kept. Nothing is auto-finalized — you review and edit
          every field next.
        </Text>
      )}
    </Screen>
  );
}
