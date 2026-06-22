/**
 * ReceiptSnap shared UI kit. Every screen composes from these primitives so the
 * app looks and behaves consistently. All components are theme-aware via
 * useTheme(). Import from '@/components/ui'.
 */
import React, { ReactNode, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text as RNText,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, fonts, sansForWeight, type Theme } from '../../theme';
import { parseMoney } from '../../lib/money';

export type IconName = keyof typeof Ionicons.glyphMap;

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------
export function Icon({
  name,
  size = 20,
  color,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  const t = useTheme();
  return <Ionicons name={name} size={size} color={color ?? t.colors.text} style={style} />;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
type TextVariant = 'title' | 'heading' | 'subheading' | 'body' | 'label' | 'caption';
export function Text({
  children,
  variant = 'body',
  color,
  weight,
  align,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  variant?: TextVariant;
  color?: string;
  weight?: '400' | '500' | '600' | '700';
  align?: TextStyle['textAlign'];
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const t = useTheme();
  // Fraunces (display serif) for titles/headings; Hanken Grotesk for the rest.
  const map: Record<TextVariant, TextStyle> = {
    title: { fontSize: t.fontSize.xxl, fontFamily: fonts.display, letterSpacing: -0.5 },
    heading: { fontSize: t.fontSize.xl, fontFamily: fonts.display, letterSpacing: -0.3 },
    subheading: { fontSize: t.fontSize.lg, fontFamily: fonts.sansSemibold },
    body: { fontSize: t.fontSize.md, fontFamily: fonts.sans },
    label: { fontSize: t.fontSize.sm, fontFamily: fonts.sansSemibold },
    caption: { fontSize: t.fontSize.xs, fontFamily: fonts.sansMedium },
  };
  const isDisplay = variant === 'title' || variant === 'heading';
  // A `weight` override only re-maps the sans families; display variants keep
  // their Fraunces face (overriding it would lose the serif identity).
  const weightFont = weight && !isDisplay ? { fontFamily: sansForWeight(weight) } : null;
  return (
    <RNText
      numberOfLines={numberOfLines}
      style={[
        { color: color ?? t.colors.text },
        map[variant],
        weightFont,
        align ? { textAlign: align } : null,
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

// ---------------------------------------------------------------------------
// Screen wrapper
// ---------------------------------------------------------------------------
export function Screen({
  children,
  scroll = false,
  padded = true,
  style,
  contentStyle,
  edges = ['top'],
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
}) {
  const t = useTheme();
  const pad = padded ? { padding: t.spacing.lg } : null;
  const body = scroll ? (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[pad, { paddingBottom: t.spacing.xxxl }, contentStyle]}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, pad, contentStyle]}>{children}</View>
  );
  return (
    <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: t.colors.bg }, style]}>
      {body}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
export function Card({
  children,
  style,
  onPress,
  padded = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  padded?: boolean;
}) {
  const t = useTheme();
  const inner = (
    <View
      style={[
        {
          backgroundColor: t.colors.card,
          borderRadius: t.radius.lg,
          borderWidth: 1,
          borderColor: t.colors.border,
          padding: padded ? t.spacing.lg : 0,
        },
        t.shadow(1),
        style,
      ]}
    >
      {children}
    </View>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => (pressed ? { opacity: 0.85 } : null)}>
        {inner}
      </Pressable>
    );
  }
  return inner;
}

// ---------------------------------------------------------------------------
// GradientHero — the signature emerald→forest mesh (gold + emerald glows) used
// behind screen headers. Cross-platform: an SVG layer paints the radial glows
// over a LinearGradient base, so it renders identically on web and native.
// ---------------------------------------------------------------------------
export function GradientHero({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const h = t.hero;
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <LinearGradient
        colors={h.base}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.4, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" pointerEvents="none">
        <Defs>
          <RadialGradient id="hg-gold" cx="86%" cy="4%" r="62%">
            <Stop offset="0" stopColor={h.glowGold} stopOpacity={1} />
            <Stop offset="1" stopColor={h.glowGold} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="hg-em" cx="4%" cy="0%" r="60%">
            <Stop offset="0" stopColor={h.glowEmerald} stopOpacity={1} />
            <Stop offset="1" stopColor={h.glowEmerald} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#hg-em)" />
        <Rect width="100%" height="100%" fill="url(#hg-gold)" />
      </Svg>
      <View>{children}</View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Monogram — brand initials chip used in receipt rows. Deterministic emerald/
// gold gradient so a vendor always gets the same colour.
// ---------------------------------------------------------------------------
const MONO_GRADS: [string, string][] = [
  ['#1FA98A', '#0C6B53'],
  ['#D8B25A', '#B0863A'],
  ['#3B6FB0', '#274E84'],
  ['#5BBE9E', '#0E7C66'],
  ['#C98A5A', '#9A5B2E'],
];
export function Monogram({ name, size = 46 }: { name: string; size?: number }) {
  const initials = (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const grad = MONO_GRADS[h % MONO_GRADS.length];
  return (
    <LinearGradient
      colors={grad}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width: size, height: size, borderRadius: size * 0.3, alignItems: 'center', justifyContent: 'center' }}
    >
      <RNText style={{ color: '#fff', fontFamily: fonts.display, fontSize: size * 0.38 }}>
        {initials || '?'}
      </RNText>
    </LinearGradient>
  );
}

// ---------------------------------------------------------------------------
// StatTile — compact metric card (label / big serif value / sub-trend).
// ---------------------------------------------------------------------------
export function StatTile({
  label,
  value,
  sub,
  subTone,
  style,
}: {
  label: string;
  value: string;
  sub?: string;
  subTone?: 'up' | 'down' | 'muted';
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const subColor =
    subTone === 'up' ? t.colors.success : subTone === 'down' ? t.colors.danger : t.colors.textMuted;
  return (
    <View
      style={[
        {
          flex: 1,
          backgroundColor: t.colors.card,
          borderRadius: t.radius.lg,
          borderWidth: 1,
          borderColor: t.colors.border,
          padding: t.spacing.lg,
        },
        t.shadow(2),
        style,
      ]}
    >
      <RNText
        style={{ color: t.colors.textFaint, fontFamily: fonts.sansBold, fontSize: 10.5, letterSpacing: 1.4 }}
      >
        {label.toUpperCase()}
      </RNText>
      <RNText
        style={{ color: t.colors.text, fontFamily: fonts.display, fontSize: t.fontSize.xxl, marginTop: 6, letterSpacing: -0.4 }}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </RNText>
      {sub ? (
        <RNText style={{ color: subColor, fontFamily: fonts.sansSemibold, fontSize: t.fontSize.xs, marginTop: 3 }}>
          {sub}
        </RNText>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'gold' | 'secondary' | 'ghost' | 'danger' | 'success';
export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
  size = 'md',
  fullWidth,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  // Gradient fills carry the brand; flat tones cover the quiet variants.
  const gradients: Partial<Record<ButtonVariant, [string, string]>> = {
    primary: [t.colors.brandLight, t.colors.brandDark],
    gold: [t.colors.goldBright, t.colors.gold],
    danger: [t.colors.danger, t.colors.danger],
    success: [t.colors.brandLight, t.colors.brand],
  };
  const fg: Record<ButtonVariant, string> = {
    primary: '#FBF6EA',
    gold: '#08311F',
    secondary: t.colors.text,
    ghost: t.colors.brand,
    danger: '#FFFFFF',
    success: '#08311F',
  };
  const pad = size === 'lg' ? t.spacing.lg : size === 'sm' ? t.spacing.sm : t.spacing.md;
  const fontSize = size === 'lg' ? t.fontSize.md : size === 'sm' ? t.fontSize.sm : t.fontSize.md;
  const grad = gradients[variant];
  const radii = size === 'lg' ? t.radius.lg : t.radius.md;

  const inner = (
    <>
      {loading ? (
        <ActivityIndicator color={fg[variant]} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={fontSize + 3} color={fg[variant]} /> : null}
          <RNText style={{ color: fg[variant], fontFamily: fonts.sansBold, fontSize, letterSpacing: 0.1 }}>
            {title}
          </RNText>
        </>
      )}
    </>
  );

  const contentStyle: ViewStyle = {
    paddingVertical: pad,
    paddingHorizontal: t.spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.spacing.sm,
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          borderRadius: radii,
          opacity: disabled ? 0.45 : pressed ? 0.9 : 1,
          alignSelf: fullWidth ? 'stretch' : undefined,
          overflow: 'hidden',
          // Omit `transform` entirely when not pressed: on the new architecture
          // a `transform: undefined` is normalized to null and crashes
          // processTransform (`null.forEach`).
          ...(pressed ? { transform: [{ scale: 0.985 }] } : null),
        },
        grad ? t.shadow(size === 'lg' ? 2 : 1) : null,
        style,
      ]}
    >
      {grad ? (
        <LinearGradient colors={grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={contentStyle}>
          {inner}
        </LinearGradient>
      ) : (
        <View
          style={[
            contentStyle,
            {
              backgroundColor: variant === 'ghost' ? 'transparent' : t.colors.surfaceAlt,
              borderWidth: variant === 'ghost' ? 1 : 0,
              borderColor: t.colors.border,
              borderRadius: radii,
            },
          ]}
        >
          {inner}
        </View>
      )}
    </Pressable>
  );
}

/** Small icon-only round button. */
export function IconButton({
  icon,
  onPress,
  color,
  background,
  size = 20,
  accessibilityLabel,
}: {
  icon: IconName;
  onPress?: () => void;
  color?: string;
  background?: string;
  size?: number;
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: size + 18,
        height: size + 18,
        borderRadius: (size + 18) / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background ?? 'transparent',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={size} color={color ?? t.colors.text} />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Divider / Spacer
// ---------------------------------------------------------------------------
export function Divider({ spacing }: { spacing?: number }) {
  const t = useTheme();
  return (
    <View
      style={{
        height: 1,
        backgroundColor: t.colors.border,
        marginVertical: spacing ?? t.spacing.md,
      }}
    />
  );
}
export function Spacer({ size = 12 }: { size?: number }) {
  return <View style={{ height: size }} />;
}
export function Row({
  children,
  gap,
  align = 'center',
  justify,
  style,
  wrap,
}: {
  children: ReactNode;
  gap?: number;
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  style?: StyleProp<ViewStyle>;
  wrap?: boolean;
}) {
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: align,
          justifyContent: justify,
          gap: gap ?? 8,
          flexWrap: wrap ? 'wrap' : 'nowrap',
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------
export function SectionHeader({
  title,
  action,
  onAction,
  actionIcon,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  actionIcon?: IconName;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: t.spacing.sm,
        marginTop: t.spacing.lg,
      }}
    >
      <Text variant="label" color={t.colors.textMuted}>
        {title.toUpperCase()}
      </Text>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {actionIcon ? <Ionicons name={actionIcon} size={16} color={t.colors.brand} /> : null}
          <Text variant="label" color={t.colors.brand}>
            {action}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Badge + ConfidenceBadge
// ---------------------------------------------------------------------------
export function Badge({
  label,
  color,
  background,
  icon,
}: {
  label: string;
  color?: string;
  background?: string;
  icon?: IconName;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: background ?? t.colors.surfaceAlt,
        paddingHorizontal: t.spacing.sm,
        paddingVertical: 3,
        borderRadius: t.radius.pill,
      }}
    >
      {icon ? <Ionicons name={icon} size={12} color={color ?? t.colors.text} /> : null}
      <RNText style={{ color: color ?? t.colors.text, fontSize: t.fontSize.xs, fontFamily: fonts.sansBold }}>
        {label}
      </RNText>
    </View>
  );
}

export function ConfidenceBadge({ level }: { level: 'high' | 'medium' | 'low' }) {
  const t = useTheme();
  const map = {
    high: { c: t.colors.confHigh, bg: t.colors.successTint, label: 'High', icon: 'checkmark-circle' as IconName },
    medium: { c: t.colors.confMedium, bg: t.colors.warningTint, label: 'Check', icon: 'alert-circle' as IconName },
    low: { c: t.colors.confLow, bg: t.colors.dangerTint, label: 'Verify', icon: 'help-circle' as IconName },
  };
  // Defensive: an unknown/undefined level (e.g. a field with no confidence yet)
  // falls back to "medium" rather than crashing.
  const m = map[level] ?? map.medium;
  return <Badge label={m.label} color={m.c} background={m.bg} icon={m.icon} />;
}

// ---------------------------------------------------------------------------
// TextField
// ---------------------------------------------------------------------------
export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  multiline,
  right,
  confidence,
  prefix,
  autoFocus,
  editable = true,
  style,
  onBlur,
  onFocus,
}: {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  multiline?: boolean;
  right?: ReactNode;
  confidence?: 'high' | 'medium' | 'low';
  prefix?: string;
  autoFocus?: boolean;
  editable?: boolean;
  style?: StyleProp<ViewStyle>;
  onBlur?: () => void;
  onFocus?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={[{ marginBottom: t.spacing.md }, style]}>
      {label ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <Text variant="label" color={t.colors.textMuted}>
            {label}
          </Text>
          {confidence ? <ConfidenceBadge level={confidence} /> : null}
        </View>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
          backgroundColor: t.colors.surface,
          borderRadius: t.radius.md,
          borderWidth: 1,
          borderColor: t.colors.border,
          paddingHorizontal: t.spacing.md,
        }}
      >
        {prefix ? (
          <RNText style={{ color: t.colors.textMuted, marginRight: 4, fontSize: t.fontSize.md }}>{prefix}</RNText>
        ) : null}
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onBlur={onBlur}
          onFocus={onFocus}
          placeholder={placeholder}
          placeholderTextColor={t.colors.textMuted}
          keyboardType={keyboardType}
          multiline={multiline}
          autoFocus={autoFocus}
          editable={editable}
          style={{
            flex: 1,
            color: t.colors.text,
            fontSize: t.fontSize.md,
            paddingVertical: multiline ? t.spacing.md : t.spacing.md,
            minHeight: multiline ? 80 : undefined,
            textAlignVertical: multiline ? 'top' : 'center',
          }}
        />
        {right}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// MoneyInput — a TextField for money/decimal amounts that keeps the user's RAW
// text while focused and only commits the parsed number on blur. A fully
// controlled input that round-trips through parseMoney on every keystroke eats
// intermediate states ("3." re-renders as "3", so typing "3.50" became 35);
// holding the raw string locally fixes that while the caller still only ever
// receives numbers.
// ---------------------------------------------------------------------------
export function MoneyInput({
  label,
  value,
  onCommit,
  placeholder = '0.00',
  keyboardType = 'decimal-pad',
  prefix,
  confidence,
  zeroAsEmpty = true,
  style,
}: {
  label?: string;
  /** The committed numeric value (null = no value yet). */
  value: number | null;
  /** Called once on blur with the parsed amount; null when the field was cleared. */
  onCommit: (v: number | null) => void;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  prefix?: string;
  confidence?: 'high' | 'medium' | 'low';
  /** Render a 0 value as an empty field (prices/totals) vs a literal "0" (tax). */
  zeroAsEmpty?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  // null = not editing (display derives from `value`); a string = the user's
  // in-progress raw text, kept verbatim so "0.", "3.5" and "" survive re-renders.
  const [draft, setDraft] = useState<string | null>(null);
  const settled =
    value == null || (zeroAsEmpty && value === 0) ? '' : String(value);
  return (
    <TextField
      label={label}
      value={draft ?? settled}
      onChangeText={setDraft}
      onFocus={() => setDraft(settled)}
      onBlur={() => {
        const raw = (draft ?? settled).trim();
        onCommit(raw === '' ? null : parseMoney(raw));
        setDraft(null);
      }}
      placeholder={placeholder}
      keyboardType={keyboardType}
      prefix={prefix}
      confidence={confidence}
      style={style}
    />
  );
}

// ---------------------------------------------------------------------------
// Stepper (qty control)
// ---------------------------------------------------------------------------
export function Stepper({
  value,
  onChange,
  min = 0,
  step = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
}) {
  const t = useTheme();
  return (
    <Row gap={0} style={{ borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radius.md, overflow: 'hidden' }}>
      <Pressable onPress={() => onChange(Math.max(min, value - step))} style={{ padding: t.spacing.sm }}>
        <Ionicons name="remove" size={18} color={t.colors.text} />
      </Pressable>
      <RNText style={{ color: t.colors.text, minWidth: 28, textAlign: 'center', fontWeight: '600' }}>{value}</RNText>
      <Pressable onPress={() => onChange(value + step)} style={{ padding: t.spacing.sm }}>
        <Ionicons name="add" size={18} color={t.colors.text} />
      </Pressable>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// SegmentedControl
// ---------------------------------------------------------------------------
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: t.colors.surfaceAlt,
        borderRadius: t.radius.md,
        padding: 3,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={{
              flex: 1,
              paddingVertical: t.spacing.sm,
              borderRadius: t.radius.sm,
              backgroundColor: active ? t.colors.surface : 'transparent',
              alignItems: 'center',
              ...(active ? t.shadow(1) : {}),
            }}
          >
            <RNText style={{ color: active ? t.colors.brand : t.colors.textMuted, fontWeight: '600', fontSize: t.fontSize.sm }}>
              {opt.label}
            </RNText>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Chip (selectable pill)
// ---------------------------------------------------------------------------
export function Chip({
  label,
  selected,
  onPress,
  color,
  icon,
  onRemove,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  color?: string;
  icon?: IconName;
  onRemove?: () => void;
}) {
  const t = useTheme();
  const accent = color ?? t.colors.brand;
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: t.spacing.sm,
        paddingHorizontal: t.spacing.md,
        borderRadius: t.radius.pill,
        borderWidth: 1,
        borderColor: selected ? accent : t.colors.border,
        backgroundColor: selected ? accent + '22' : t.colors.surface,
      }}
    >
      {icon ? <Ionicons name={icon} size={14} color={selected ? accent : t.colors.textMuted} /> : null}
      <RNText style={{ color: selected ? accent : t.colors.text, fontWeight: '600', fontSize: t.fontSize.sm }}>
        {label}
      </RNText>
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={8}>
          <Ionicons name="close" size={14} color={selected ? accent : t.colors.textMuted} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// ListRow
// ---------------------------------------------------------------------------
export function ListRow({
  title,
  subtitle,
  left,
  right,
  rightText,
  onPress,
  icon,
  iconColor,
  destructive,
}: {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
  rightText?: string;
  onPress?: () => void;
  icon?: IconName;
  iconColor?: string;
  destructive?: boolean;
}) {
  const t = useTheme();
  const titleColor = destructive ? t.colors.danger : t.colors.text;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: t.spacing.md,
        gap: t.spacing.md,
        opacity: pressed && onPress ? 0.6 : 1,
      })}
    >
      {icon ? (
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: t.radius.md,
            backgroundColor: (iconColor ?? t.colors.brand) + '22',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={icon} size={18} color={iconColor ?? t.colors.brand} />
        </View>
      ) : (
        left
      )}
      <View style={{ flex: 1 }}>
        <RNText style={{ color: titleColor, fontSize: t.fontSize.md, fontFamily: fonts.sansSemibold }}>{title}</RNText>
        {subtitle ? (
          <RNText style={{ color: t.colors.textMuted, fontSize: t.fontSize.sm, marginTop: 2, fontFamily: fonts.sansMedium }}>{subtitle}</RNText>
        ) : null}
      </View>
      {rightText ? <RNText style={{ color: t.colors.text, fontSize: t.fontSize.md, fontFamily: fonts.display }}>{rightText}</RNText> : null}
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={t.colors.textMuted} /> : null)}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------
export function EmptyState({
  icon = 'document-text-outline',
  title,
  message,
  action,
  onAction,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  action?: string;
  onAction?: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', padding: t.spacing.xxl, gap: t.spacing.md }}>
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 36,
          backgroundColor: t.colors.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name={icon} size={32} color={t.colors.textMuted} />
      </View>
      <Text variant="subheading" align="center">
        {title}
      </Text>
      {message ? (
        <Text variant="body" color={t.colors.textMuted} align="center">
          {message}
        </Text>
      ) : null}
      {action && onAction ? <Button title={action} onPress={onAction} variant="primary" /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// SelectSheet — modal single/multi picker used everywhere (categories, etc.)
// ---------------------------------------------------------------------------
export interface SelectOption {
  label: string;
  value: string;
  color?: string;
  icon?: IconName;
  subtitle?: string;
}

export function SelectSheet({
  visible,
  title,
  options,
  selected,
  multi,
  onClose,
  onSelect,
  footer,
}: {
  visible: boolean;
  title: string;
  options: SelectOption[];
  selected: string[];
  multi?: boolean;
  onClose: () => void;
  onSelect: (values: string[]) => void;
  footer?: ReactNode;
}) {
  const t = useTheme();
  const toggle = (v: string) => {
    if (multi) {
      onSelect(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
    } else {
      onSelect([v]);
      onClose();
    }
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }} onPress={onClose}>
        <Pressable
          style={{
            backgroundColor: t.colors.bg,
            borderTopLeftRadius: t.radius.xl,
            borderTopRightRadius: t.radius.xl,
            paddingTop: t.spacing.md,
            maxHeight: '75%',
          }}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={{ alignItems: 'center', paddingBottom: t.spacing.sm }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: t.colors.border }} />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.sm }}>
            <Text variant="subheading">{title}</Text>
            <IconButton icon="close" onPress={onClose} />
          </View>
          <Divider spacing={0} />
          <ScrollView contentContainerStyle={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.xl }}>
            {options.map((opt) => {
              const isSel = selected.includes(opt.value);
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => toggle(opt.value)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md, paddingVertical: t.spacing.md }}
                >
                  {opt.color ? (
                    <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: opt.color }} />
                  ) : opt.icon ? (
                    <Ionicons name={opt.icon} size={20} color={t.colors.textMuted} />
                  ) : null}
                  <View style={{ flex: 1 }}>
                    <RNText style={{ color: t.colors.text, fontSize: t.fontSize.md }}>{opt.label}</RNText>
                    {opt.subtitle ? (
                      <RNText style={{ color: t.colors.textMuted, fontSize: t.fontSize.xs }}>{opt.subtitle}</RNText>
                    ) : null}
                  </View>
                  {isSel ? <Ionicons name="checkmark" size={20} color={t.colors.brand} /> : null}
                </Pressable>
              );
            })}
            {footer}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------
export function LoadingOverlay({ visible, message }: { visible: boolean; message?: string }) {
  const t = useTheme();
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade">
      <View style={{ flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', gap: t.spacing.md }}>
        <View style={{ backgroundColor: t.colors.card, padding: t.spacing.xl, borderRadius: t.radius.lg, alignItems: 'center', gap: t.spacing.md, minWidth: 180 }}>
          <ActivityIndicator size="large" color={t.colors.brand} />
          {message ? <Text variant="body">{message}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

export { useTheme };
export type { Theme };
