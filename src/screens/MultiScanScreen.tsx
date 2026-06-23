/**
 * Multi Scan — two modes:
 *  (a) Separate receipts: capture/import several, each becomes its own pending
 *      receipt to review later from History.
 *  (b) Stitch: several photos of ONE long receipt are combined into a single
 *      receipt (every page's text is read), then extracted as one receipt now.
 *  (c) Split: ONE photo of several receipts laid out together is detected and
 *      split (on-device) into separate entries via the split-review screen.
 */
import { useRef, useState } from 'react';
import { Alert, View, ScrollView } from 'react-native';
import { Image } from 'expo-image';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import {
  Screen,
  Card,
  Button,
  Text,
  Row,
  SegmentedControl,
  IconButton,
  LoadingOverlay,
  EmptyState,
  useTheme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import { useLookups } from '@/store/lookups';
import { useDraft } from '@/store/draft';
import { pickReceiptsWithMeta, parseAssetMeta } from '@/services/imagePipeline';
import { runBatch, processStitchedPages, MAX_BATCH } from '@/services/batchService';
import { getCurrentCoords, type DeviceCoords } from '@/services/locationService';
import { persistDraft } from '@/services/receiptService';
import { listPaymentMethods } from '@/db/paymentMethods';
import { detectPayment } from '@/lib/paymentDetect';
import type { ImageMeta } from '@/types';

interface Shot {
  uri: string;
  meta: ImageMeta | null;
}

type Mode = 'separate' | 'stitch' | 'split';

export default function MultiScanScreen() {
  const t = useTheme();
  const { settings, canScan } = useSettings();
  const [mode, setMode] = useState<Mode>('separate');
  const [shots, setShots] = useState<Shot[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState<string | null>(null);
  const camRef = useRef<CameraView>(null);

  const addFromGallery = async () => {
    // Import multiple receipts AND read each photo's EXIF (capture time + GPS).
    const picked = await pickReceiptsWithMeta({ multiple: true });
    if (picked.length) setShots((s) => [...s, ...picked]);
  };

  const openCamera = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) return;
    }
    setCameraOpen(true);
  };

  const lookups = useLookups();

  /** Match a suggested category name to a real category id (for pre-fill). */
  const categoryIdFor = (name?: string | null): string | null => {
    if (!name) return null;
    const hit = lookups.categories.find(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
    return hit?.id ?? null;
  };

  const processAll = async () => {
    if (shots.length === 0) return;
    if (!canScan()) {
      router.replace('/paywall');
      return;
    }

    if (mode === 'split') {
      // Hand the source photo(s) to the on-device split-review flow, which
      // detects, crops and rotates each receipt before extraction.
      router.push({
        pathname: '/split-review',
        params: { uris: JSON.stringify(shots.map((s) => s.uri)) },
      });
      return;
    }

    try {
      if (mode === 'stitch') {
        // Read EVERY page (on-device) and extract once — no longer just page 1.
        setBusy('Reading all pages…');
        const { extraction } = await processStitchedPages(
          shots.map((s) => s.uri),
          { autoCrop: settings.auto_crop, deskew: settings.enhance_deskew },
        );
        useDraft.getState().startFromExtraction(extraction, {
          imageUris: shots.map((s) => s.uri), // keep every page image
          // The genuine unprocessed first capture — never an enhanced copy.
          originalImageUri: shots[0]?.uri ?? null,
          source: 'camera',
          imageFormat: settings.image_format,
        });
        const cat = categoryIdFor(extraction.category);
        if (cat) useDraft.getState().setField('category_id', cat);
        router.replace('/review');
        return;
      }

      // separate: each shot -> its own pending receipt, via the bounded batch
      // pipeline (concurrent extraction, then sequential persistence).
      // Cap the batch UP FRONT to the free scans the user has left (each shot
      // costs an extraction call AND persists a receipt), then to MAX_BATCH.
      const remaining = useSettings.getState().scansRemaining();
      let queue = shots;
      if (queue.length > remaining) {
        queue = queue.slice(0, remaining);
        Alert.alert(
          'Free scan limit',
          `You have ${remaining} free scan${remaining === 1 ? '' : 's'} left — processing the first ${remaining} of ${shots.length} photos. Unlock for unlimited scans.`,
        );
      }
      if (queue.length > MAX_BATCH) {
        Alert.alert('Multi Scan', `Processing the first ${MAX_BATCH} of ${queue.length} photos in this batch.`);
      }
      setBusy(`Processing 0/${Math.min(queue.length, MAX_BATCH)}…`);
      const results = await runBatch(
        queue.map((s) => ({ uri: s.uri, meta: s.meta })),
        {
          concurrency: 3,
          autoCrop: settings.auto_crop,
          deskew: settings.enhance_deskew,
          onProgress: (d, total) => setBusy(`Processing ${d}/${total}…`),
        },
      );

      // Load the user's payment methods ONCE for on-device payment auto-detection
      // across the whole batch (TASK 41). Best-effort — empty on failure.
      let paymentMethods: { id: string; name: string }[] = [];
      try {
        paymentMethods = await listPaymentMethods();
      } catch {
        paymentMethods = [];
      }

      // Resolve a single device-location fix for the WHOLE batch (TASK 46) when
      // the user opted in — a batch is captured at one place/time, so we avoid
      // prompting/fetching per receipt. Only used to fill receipts lacking EXIF
      // GPS. Best-effort: null when permission is denied or unavailable.
      let batchCoords: DeviceCoords | null = null;
      if (settings.geotag_receipts) {
        batchCoords = await getCurrentCoords();
      }

      let done = 0;
      let limitHit = false;
      for (const r of results) {
        if (!r.extraction) continue;
        // Re-check before EVERY persist — persistDraft keeps the scan count
        // live, so a batch can never blow past the free-scan limit.
        if (!useSettings.getState().canScan()) {
          limitHit = true;
          break;
        }
        const draft = useDraft.getState();
        draft.startFromExtraction(r.extraction, {
          imageUris: [r.uri],
          originalImageUri: r.originalUri,
          source: 'camera',
          imageFormat: settings.image_format,
        });
        const cat = categoryIdFor(r.extraction.category);
        if (cat) draft.setField('category_id', cat);
        // Auto-detect the payment method/card from this receipt's OCR text and
        // pre-fill it (TASK 41). Non-destructive — only fills an unset method.
        if (r.ocrText) {
          const detection = detectPayment(r.ocrText, paymentMethods);
          if (detection.brand) draft.applyPaymentDetection(detection);
        }
        // Carry EXIF capture metadata; use capture date if the model found none.
        // When EXIF has no GPS, fall back to the batch device-location fix
        // (TASK 46, opt-in). Apply even when there's no EXIF block at all.
        const exifLat = r.meta?.lat ?? null;
        const exifLng = r.meta?.lng ?? null;
        const useBatchCoords = batchCoords && exifLat == null && exifLng == null;
        if (r.meta || useBatchCoords) {
          const cur = useDraft.getState();
          cur.patch({
            captured_at: r.meta?.capturedAt ?? null,
            captured_lat: useBatchCoords ? batchCoords!.lat : exifLat,
            captured_lng: useBatchCoords ? batchCoords!.lng : exifLng,
            ...(!cur.date && r.meta?.capturedAt
              ? { date: r.meta.capturedAt.slice(0, 10), date_options: [r.meta.capturedAt.slice(0, 10)] }
              : {}),
          });
        }
        await persistDraft({ finalize: false }); // saved as pending
        useDraft.getState().reset();
        done++;
      }
      setBusy(null);
      if (limitHit) {
        Alert.alert(
          'Free scan limit reached',
          `${done} receipt${done === 1 ? '' : 's'} saved before the free limit was reached.`,
          [
            { text: 'View history', onPress: () => router.replace('/history') },
            { text: 'Unlock · $9.99', onPress: () => router.replace('/paywall') },
          ],
        );
        return;
      }
      Alert.alert('Multi Scan', `${done} receipt${done === 1 ? '' : 's'} added to your pending list to review.`);
      router.replace('/history');
    } catch {
      Alert.alert('Multi Scan failed', 'Something went wrong while processing. Your photos are still here — try again.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Retry', onPress: () => processAll() },
      ]);
    } finally {
      setBusy(null); // never leave the overlay stuck on an error
    }
  };

  if (cameraOpen) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView ref={camRef} style={{ flex: 1 }} facing="back" />
        <View style={{ position: 'absolute', top: 48, left: 16 }}>
          <IconButton icon="checkmark" color="#fff" size={28} onPress={() => setCameraOpen(false)} />
        </View>
        <View style={{ position: 'absolute', bottom: 48, width: '100%', alignItems: 'center', gap: 6 }}>
          <IconButton
            icon="ellipse"
            size={64}
            color="#fff"
            onPress={async () => {
              const photo = await camRef.current?.takePictureAsync({ quality: 0.8, exif: true });
              if (photo?.uri) {
                const meta = parseAssetMeta({ uri: photo.uri, width: photo.width, height: photo.height, exif: photo.exif });
                setShots((s) => [...s, { uri: photo.uri, meta }]);
              }
            }}
          />
          <Text color="#fff" variant="caption">
            {shots.length} captured · tap ✓ when done
          </Text>
        </View>
      </View>
    );
  }

  return (
    <Screen scroll>
      <LoadingOverlay visible={!!busy} message={busy ?? ''} />

      <SegmentedControl<Mode>
        value={mode}
        onChange={setMode}
        options={[
          { label: 'Separate', value: 'separate' },
          { label: 'Stitch', value: 'stitch' },
          { label: 'Split', value: 'split' },
        ]}
      />
      <Text variant="caption" color={t.colors.textMuted} style={{ marginTop: t.spacing.sm }}>
        {mode === 'separate'
          ? 'Capture several different receipts — each becomes its own entry to review.'
          : mode === 'stitch'
            ? 'Capture several photos of ONE long receipt — every page is read and combined into a single receipt.'
            : 'Take ONE photo of several receipts laid out together — we detect and split them into separate entries (on-device, free).'}
      </Text>

      <Row gap={t.spacing.md} style={{ marginTop: t.spacing.lg }}>
        <Button title="Camera" icon="camera" style={{ flex: 1 }} onPress={openCamera} />
        <Button title="Gallery" icon="images-outline" variant="secondary" style={{ flex: 1 }} onPress={addFromGallery} />
      </Row>

      {shots.length === 0 ? (
        <EmptyState icon="albums-outline" title="No photos yet" message="Add photos with the camera or from your gallery." />
      ) : (
        <Card style={{ marginTop: t.spacing.lg }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Row gap={t.spacing.sm}>
              {shots.map((shot, i) => (
                <View key={`${shot.uri}-${i}`}>
                  <Image source={{ uri: shot.uri }} style={{ width: 90, height: 120, borderRadius: t.radius.md }} contentFit="cover" />
                  <View style={{ position: 'absolute', top: -6, right: -6 }}>
                    <IconButton
                      icon="close-circle"
                      size={20}
                      color={t.colors.danger}
                      background={t.colors.surface}
                      onPress={() => setShots((s) => s.filter((_, idx) => idx !== i))}
                    />
                  </View>
                  <Text variant="caption" align="center" color={t.colors.textMuted}>
                    {mode === 'stitch' ? `Page ${i + 1}` : `#${i + 1}`}
                  </Text>
                </View>
              ))}
            </Row>
          </ScrollView>
        </Card>
      )}

      {shots.length > 0 ? (
        <Button
          title={
            mode === 'stitch'
              ? 'Combine & extract'
              : mode === 'split'
                ? 'Detect & split'
                : `Process ${shots.length} receipt${shots.length === 1 ? '' : 's'}`
          }
          size="lg"
          icon="sparkles"
          style={{ marginTop: t.spacing.lg }}
          onPress={processAll}
        />
      ) : null}
    </Screen>
  );
}
