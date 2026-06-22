/**
 * Split Review — the review step for "one photo → many receipts".
 *
 * Reached from Quick Scan (when a capture turns out to contain several receipts)
 * and from Multi Scan's "Split" mode. Given one or more source photos (passed as
 * a JSON `uris` param), it detects the receipts in each ON-DEVICE for free,
 * crops + auto-rotates each into its own image, and shows them in a grid the user
 * can prune before anything is saved. Confirming runs every crop through the same
 * extraction pipeline as a normal scan, saving each as a pending receipt.
 *
 * Cost note: detection/cropping/rotation are all on-device (no Gemini). The only
 * Gemini touch is the optional "Refine with AI" button, which is paywall-gated.
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { Button, EmptyState, LoadingOverlay, Screen, Text, useTheme } from '@/components/ui';
import { DetectedReceiptsGrid, type DetectedCrop } from '@/components/DetectedReceiptsGrid';
import { useSettings } from '@/store/settings';
import { useLookups } from '@/store/lookups';
import { useDraft } from '@/store/draft';
import { detectReceiptRegions, inspectCrop } from '@/services/receiptDetect';
import { detectReceiptRegionsAI } from '@/services/detectClient';
import { splitImageIntoReceipts } from '@/services/imagePipeline';
import { runBatch } from '@/services/batchService';
import { persistDraft } from '@/services/receiptService';
import type { DetectedRegion } from '@/types';

/** Region covering the whole image — fallback when detection finds nothing. */
const FULL_IMAGE: DetectedRegion = { x: 0, y: 0, width: 1, height: 1 };

export default function SplitReviewScreen() {
  const t = useTheme();
  const { settings, canScan } = useSettings();
  const lookups = useLookups();
  const params = useLocalSearchParams<{ uris?: string }>();

  const [loading, setLoading] = useState(true);
  const [crops, setCrops] = useState<DetectedCrop[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const sourceUris = useMemo<string[]>(() => {
    try {
      const parsed = JSON.parse(params.uris ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
    } catch {
      return [];
    }
  }, [params.uris]);

  /** Crop + auto-rotate each source photo's detected regions into crop uris. */
  const buildCrops = async (
    regionsFor: (src: string) => Promise<DetectedRegion[]>,
  ): Promise<string[]> => {
    const all: string[] = [];
    for (const src of sourceUris) {
      let regions = await regionsFor(src);
      if (regions.length === 0) regions = [FULL_IMAGE]; // couldn't detect → whole photo
      const cropped = await splitImageIntoReceipts(src, regions, { autoRotate: true });
      all.push(...cropped);
    }
    return all;
  };

  /** Kick off background on-device quality assessment, matched back by uri. */
  const assessQuality = (uris: string[], isCancelled: () => boolean) => {
    uris.forEach(async (uri) => {
      const q = await inspectCrop(uri);
      if (isCancelled()) return;
      setCrops((prev) => prev.map((c) => (c.uri === uri ? { ...c, quality: q } : c)));
    });
  };

  // Detect + split on mount (and whenever the source photos change).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const uris = await buildCrops(detectReceiptRegions);
      if (cancelled) return;
      setCrops(uris.map((uri) => ({ uri, quality: null })));
      setLoading(false);
      assessQuality(uris, () => cancelled);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUris]);

  const removeCrop = (index: number) =>
    setCrops((prev) => prev.filter((_, i) => i !== index));

  /** Match a suggested category name to a real category id (for pre-fill). */
  const categoryIdFor = (name?: string | null): string | null => {
    if (!name) return null;
    const hit = lookups.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
    return hit?.id ?? null;
  };

  /** Optional, paywall-gated: ask the backend (Gemini) for a better split. */
  const refineWithAI = async () => {
    if (!canScan()) {
      router.replace('/paywall');
      return;
    }
    setBusy('Refining with AI…');
    try {
      let improved = false;
      const uris = await buildCrops(async (src) => {
        const regions = await detectReceiptRegionsAI({ imageUri: src });
        if (regions.length > 0) improved = true;
        return regions;
      });
      if (improved) {
        setCrops(uris.map((uri) => ({ uri, quality: null })));
        assessQuality(uris, () => false);
      } else {
        Alert.alert(
          'Refine with AI',
          'Could not improve the split (offline or scan limit reached). Keeping the current split.',
        );
      }
    } catch {
      Alert.alert('Refine with AI', 'Refinement failed. Keeping the current split.');
    } finally {
      setBusy(null); // never leave the overlay stuck on an error
    }
  };

  const processAll = async () => {
    if (crops.length === 0) return;
    if (!canScan()) {
      router.replace('/paywall');
      return;
    }
    try {
      // Cap the batch UP FRONT to the free scans the user has left (each crop
      // costs an extraction call AND persists a receipt).
      const remaining = useSettings.getState().scansRemaining();
      let queue = crops;
      if (queue.length > remaining) {
        queue = queue.slice(0, remaining);
        Alert.alert(
          'Free scan limit',
          `You have ${remaining} free scan${remaining === 1 ? '' : 's'} left — processing the first ${remaining} of ${crops.length} receipts. Unlock for unlimited scans.`,
        );
      }
      setBusy(`Processing 0/${queue.length}…`);
      const results = await runBatch(
        queue.map((c) => ({ uri: c.uri })),
        {
          concurrency: 3,
          autoCrop: settings.auto_crop,
          onProgress: (d, total) => setBusy(`Processing ${d}/${total}…`),
        },
      );

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
      Alert.alert(
        'Split scan',
        `${done} receipt${done === 1 ? '' : 's'} added to your pending list to review.`,
      );
      router.replace('/history');
    } catch {
      Alert.alert('Split scan failed', 'Something went wrong while processing. Your crops are still here — try again.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Retry', onPress: () => processAll() },
      ]);
    } finally {
      setBusy(null); // never leave the overlay stuck on an error
    }
  };

  return (
    <Screen scroll>
      <LoadingOverlay visible={loading || !!busy} message={busy ?? 'Detecting receipts…'} />

      {!loading && crops.length === 0 ? (
        <EmptyState
          icon="scan-outline"
          title="No receipts detected"
          message="Try retaking the photo with the receipts spread apart on a plain background."
          action="Go back"
          onAction={() => router.back()}
        />
      ) : (
        <>
          <Text variant="heading">
            {crops.length} receipt{crops.length === 1 ? '' : 's'} found
          </Text>
          <Text
            variant="caption"
            color={t.colors.textMuted}
            style={{ marginTop: 4, marginBottom: t.spacing.lg }}
          >
            Remove any wrong crops, then process — each becomes its own entry to review.
            Detection runs on your device, free.
          </Text>

          <DetectedReceiptsGrid crops={crops} onRemove={removeCrop} />

          <Button
            title={`Process ${crops.length} receipt${crops.length === 1 ? '' : 's'}`}
            size="lg"
            icon="sparkles"
            style={{ marginTop: t.spacing.xl }}
            onPress={processAll}
          />
          <Button
            title="Refine with AI"
            variant="ghost"
            icon="cloud-outline"
            style={{ marginTop: t.spacing.md }}
            onPress={refineWithAI}
          />
          <Text
            variant="caption"
            color={t.colors.textMuted}
            align="center"
            style={{ marginTop: t.spacing.sm }}
          >
            Refine uses one online scan to improve the split only if the on-device result looks off.
          </Text>
        </>
      )}
    </Screen>
  );
}
