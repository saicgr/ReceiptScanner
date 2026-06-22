/**
 * Grid of detected receipt crops shown on the split-review screen.
 *
 * Presentational only: the parent owns the crop list and decides what "process"
 * and "refine" do. Each tile shows the cropped receipt, a remove button (so the
 * user can drop a false/duplicate crop before anything is saved — matching the
 * app's "nothing auto-finalized" rule), and an on-device quality badge flagging
 * crops that may need a re-shoot.
 */
import { View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Badge, IconButton, Text, useTheme } from '@/components/ui';
import type { CropQuality } from '@/types';

export interface DetectedCrop {
  uri: string;
  /** On-device quality verdict; null while still being assessed. */
  quality?: CropQuality | null;
}

export function DetectedReceiptsGrid({
  crops,
  onRemove,
}: {
  crops: DetectedCrop[];
  onRemove: (index: number) => void;
}) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  // Two columns inside the Screen's horizontal padding (t.spacing.lg each side).
  const gap = t.spacing.sm;
  const tileW = Math.floor((width - t.spacing.lg * 2 - gap) / 2);
  const tileH = Math.round(tileW * 1.3);

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
      {crops.map((crop, i) => {
        const flagged = crop.quality && !crop.quality.ok;
        return (
          <View key={`${crop.uri}-${i}`} style={{ width: tileW }}>
            <View
              style={{
                width: tileW,
                height: tileH,
                borderRadius: t.radius.md,
                overflow: 'hidden',
                backgroundColor: t.colors.surfaceAlt,
                borderWidth: flagged ? 2 : 1,
                borderColor: flagged ? t.colors.warning : t.colors.border,
              }}
            >
              <Image source={{ uri: crop.uri }} style={{ flex: 1 }} contentFit="cover" />
              {/* Remove this crop */}
              <View style={{ position: 'absolute', top: 4, right: 4 }}>
                <IconButton
                  icon="close-circle"
                  size={22}
                  color={t.colors.danger}
                  background={t.colors.surface}
                  accessibilityLabel={`Remove receipt ${i + 1}`}
                  onPress={() => onRemove(i)}
                />
              </View>
              {/* Index pill */}
              <View style={{ position: 'absolute', top: 6, left: 6 }}>
                <Badge label={`#${i + 1}`} background={t.colors.surface} />
              </View>
              {/* Quality flag */}
              {flagged ? (
                <View style={{ position: 'absolute', bottom: 6, left: 6 }}>
                  <Badge
                    label="Check"
                    icon="alert-circle"
                    color={t.colors.warning}
                    background={t.colors.warningTint}
                  />
                </View>
              ) : null}
            </View>
            {flagged && crop.quality?.reasons[0] ? (
              <Text variant="caption" color={t.colors.textMuted} numberOfLines={2} style={{ marginTop: 2 }}>
                {crop.quality.reasons[0]}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
