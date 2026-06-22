/**
 * Full-screen original-image viewer. Pinch/zoom via a ScrollView with
 * maximumZoomScale (simple + reliable across platforms). Supports a single
 * `uri` or a JSON `uris` array with a starting `index`. Share + close.
 *
 * Multi-page receipts (stitched long receipts, multi-page PDFs) are first-class
 * here: pages are rendered in a horizontal, swipeable pager (each page
 * independently zoomable) with tappable dots, so the user genuinely sees the
 * WHOLE long receipt full-screen — this is the deliberate alternative to
 * compositing the pages into one tall file on-device (see
 * `imagePipeline.stitchImages` for why compositing was not done).
 */
import { useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { Text, IconButton, Row, useTheme } from '@/components/ui';

export default function ImageViewerScreen() {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const params = useLocalSearchParams<{ uri?: string; uris?: string; index?: string }>();

  const uris: string[] = (() => {
    if (params.uris) {
      try {
        const parsed = JSON.parse(params.uris);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      } catch {
        /* ignore */
      }
    }
    return params.uri ? [params.uri] : [];
  })();

  const [index, setIndex] = useState(
    Math.min(Number(params.index ?? 0) || 0, Math.max(0, uris.length - 1)),
  );
  const pagerRef = useRef<FlatList<string>>(null);
  const current = uris[index];

  const share = async () => {
    if (current && (await Sharing.isAvailableAsync())) {
      await Sharing.shareAsync(current);
    }
  };

  /** Jump to a page (dot tap) and keep the pager in sync. */
  const goTo = (i: number) => {
    setIndex(i);
    pagerRef.current?.scrollToIndex({ index: i, animated: true });
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Row
        justify="space-between"
        align="center"
        style={{ paddingTop: 52, paddingHorizontal: 16, paddingBottom: 8 }}
      >
        <IconButton icon="close" color="#fff" onPress={() => router.back()} accessibilityLabel="Close" />
        <Text variant="label" color="#fff">
          {uris.length > 1 ? `Page ${index + 1} / ${uris.length}` : ''}
        </Text>
        <IconButton icon="share-outline" color="#fff" onPress={share} accessibilityLabel="Share" />
      </Row>

      {uris.length > 0 ? (
        <FlatList
          ref={pagerRef}
          data={uris}
          horizontal
          pagingEnabled
          initialScrollIndex={index}
          // Fixed page width lets initialScrollIndex work without measuring.
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          keyExtractor={(u, i) => `${u}-${i}`}
          onMomentumScrollEnd={(e) =>
            setIndex(
              Math.max(0, Math.min(uris.length - 1, Math.round(e.nativeEvent.contentOffset.x / width))),
            )
          }
          showsHorizontalScrollIndicator={false}
          renderItem={({ item }) => (
            // Each page gets its own zoomable ScrollView so pinch/zoom on one
            // page never fights the pager's horizontal swipe on another.
            <ScrollView
              style={{ width }}
              maximumZoomScale={4}
              minimumZoomScale={1}
              centerContent
              contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
              showsVerticalScrollIndicator={false}
              showsHorizontalScrollIndicator={false}
            >
              <Image
                source={{ uri: item }}
                style={{ width, height: height - 180 }}
                contentFit="contain"
              />
            </ScrollView>
          )}
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text color="#fff">Image unavailable</Text>
        </View>
      )}

      {uris.length > 1 ? (
        <Row justify="center" gap={8} style={{ paddingVertical: 24 }}>
          {uris.map((_, i) => (
            <Pressable
              key={i}
              onPress={() => goTo(i)}
              accessibilityLabel={`Page ${i + 1}`}
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: i === index ? '#fff' : '#ffffff55',
              }}
            />
          ))}
        </Row>
      ) : (
        <View style={{ height: 24 }} />
      )}
    </View>
  );
}
