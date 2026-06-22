/**
 * ReceiptSnap design tokens — the "VAULT" system. A single source of truth for
 * color, type, spacing, radius and depth so every screen shares one editorial,
 * private-bank aesthetic: warm paper + ink in light, forest-black + cream in
 * dark, deep emerald brand with a champagne-gold accent throughout.
 *
 * Type pairs Fraunces (an optical display serif, used for the wordmark, screen
 * titles and money numerals) with Hanken Grotesk (UI/body). Those font families
 * are loaded at startup (see src/hooks/useFonts) and referenced here by their
 * exact per-weight names.
 */
import { useColorScheme } from 'react-native';

const palette = {
  // Emerald — receipts / money / "go"
  emDeepL: '#093D2F',
  emerald: '#0E7C66',
  emBright: '#15A084',
  emTintL: '#E2F0EA',
  emGlowD: '#2BC6A6',
  emTintD: '#10312A',

  // Champagne gold — premium accent
  gold: '#B68A3C',
  goldBright: '#D8B25A',
  goldTintL: '#F3E8CC',
  goldTintD: '#2E2613',
  goldGlowD: '#EBCB7E',

  // Warm neutrals (light)
  paper: '#F4EFE6',
  paperWarm: '#EFE9DD',
  cream: '#FBF8F2',
  lineL: '#E8E1D3',
  inkL: '#16221D',
  inkSoftL: '#5C6B63',
  inkFaintL: '#93A097',

  // Forest neutrals (dark)
  forest: '#070B09',
  forest2: '#0B1310',
  cardD: '#141E19',
  cardD2: '#172420',
  lineD: '#26322C',
  inkD: '#ECE7D9',
  inkSoftD: '#9DAAA1',
  inkFaintD: '#6C7A72',

  white: '#FFFFFF',
  black: '#000000',

  // Status
  successL: '#0A6B4E',
  successD: '#2BC6A6',
  warnL: '#B07A1E',
  warnD: '#EBCB7E',
  dangerL: '#C24A3B',
  dangerD: '#E0705F',
  dangerTintL: '#F7E2DD',
  dangerTintD: '#33201C',
  infoL: '#2F5FA6',
  infoD: '#8FB4E6',
  infoTintL: '#E1EAF6',
  infoTintD: '#16243A',
};

export interface ThemeColors {
  brand: string;
  brandDark: string;
  brandLight: string;
  brandTint: string;

  /** Champagne-gold accent + supporting tones. */
  gold: string;
  goldBright: string;
  goldTint: string;

  bg: string;
  surface: string;
  surfaceAlt: string;
  card: string;
  /** Slightly raised surface (sheets, elevated cards). */
  cardAlt: string;
  border: string;

  text: string;
  textMuted: string;
  /** Faintest tier — uppercase eyebrow labels, meta. */
  textFaint: string;
  textInverse: string;
  /** Cream foreground used on emerald/gold gradient surfaces. */
  onHero: string;
  onHeroMuted: string;

  success: string;
  successTint: string;
  warning: string;
  warningTint: string;
  danger: string;
  dangerTint: string;
  info: string;
  infoTint: string;

  confHigh: string;
  confMedium: string;
  confLow: string;
}

/** Stops for the signature emerald→forest hero with gold + emerald glows. */
export interface HeroStops {
  base: [string, string, string];
  glowGold: string;
  glowEmerald: string;
}

const lightColors: ThemeColors = {
  brand: palette.emerald,
  brandDark: palette.emDeepL,
  brandLight: palette.emBright,
  brandTint: palette.emTintL,

  gold: palette.gold,
  goldBright: palette.goldBright,
  goldTint: palette.goldTintL,

  bg: palette.paper,
  surface: palette.white,
  surfaceAlt: palette.paperWarm,
  card: palette.white,
  cardAlt: palette.cream,
  border: palette.lineL,

  text: palette.inkL,
  textMuted: palette.inkSoftL,
  textFaint: palette.inkFaintL,
  textInverse: palette.white,
  onHero: '#FBF6EA',
  onHeroMuted: 'rgba(251,246,234,0.68)',

  success: palette.successL,
  successTint: palette.emTintL,
  warning: palette.warnL,
  warningTint: palette.goldTintL,
  danger: palette.dangerL,
  dangerTint: palette.dangerTintL,
  info: palette.infoL,
  infoTint: palette.infoTintL,

  confHigh: palette.successL,
  confMedium: palette.gold,
  confLow: palette.dangerL,
};

const darkColors: ThemeColors = {
  brand: palette.emBright,
  brandDark: palette.emerald,
  brandLight: palette.emGlowD,
  brandTint: palette.emTintD,

  gold: palette.goldBright,
  goldBright: palette.goldGlowD,
  goldTint: palette.goldTintD,

  bg: palette.forest2,
  surface: palette.cardD,
  surfaceAlt: palette.cardD2,
  card: palette.cardD,
  cardAlt: palette.cardD2,
  border: palette.lineD,

  text: palette.inkD,
  textMuted: palette.inkSoftD,
  textFaint: palette.inkFaintD,
  textInverse: palette.forest,
  onHero: '#FCF7EC',
  onHeroMuted: 'rgba(252,247,236,0.66)',

  success: palette.successD,
  successTint: palette.emTintD,
  warning: palette.warnD,
  warningTint: palette.goldTintD,
  danger: palette.dangerD,
  dangerTint: palette.dangerTintD,
  info: palette.infoD,
  infoTint: palette.infoTintD,

  confHigh: palette.successD,
  confMedium: palette.goldBright,
  confLow: palette.dangerD,
};

const lightHero: HeroStops = {
  base: ['#0E6E58', '#0A4536', '#07301F'],
  glowGold: 'rgba(216,178,90,0.55)',
  glowEmerald: 'rgba(21,160,132,0.62)',
};
const darkHero: HeroStops = {
  base: ['#0C5747', '#062A20', '#03130D'],
  glowGold: 'rgba(216,178,90,0.42)',
  glowEmerald: 'rgba(43,198,166,0.42)',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 26,
  pill: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 18,
  xl: 22,
  xxl: 28,
  xxxl: 40,
  display: 56,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/** Exact per-weight font-family names loaded at startup. */
export const fonts = {
  display: 'Fraunces_600SemiBold',
  displayMedium: 'Fraunces_500Medium',
  displayBold: 'Fraunces_700Bold',
  sans: 'HankenGrotesk_400Regular',
  sansMedium: 'HankenGrotesk_500Medium',
  sansSemibold: 'HankenGrotesk_600SemiBold',
  sansBold: 'HankenGrotesk_700Bold',
  sansExtra: 'HankenGrotesk_800ExtraBold',
} as const;

/** Map a CSS-style weight string to the matching Hanken Grotesk family. */
export function sansForWeight(w?: string): string {
  switch (w) {
    case '500':
      return fonts.sansMedium;
    case '600':
      return fonts.sansSemibold;
    case '700':
      return fonts.sansBold;
    case '800':
      return fonts.sansExtra;
    default:
      return fonts.sans;
  }
}

export interface Theme {
  colors: ThemeColors;
  hero: HeroStops;
  spacing: typeof spacing;
  radius: typeof radius;
  fontSize: typeof fontSize;
  fontWeight: typeof fontWeight;
  fonts: typeof fonts;
  isDark: boolean;
  shadow: (level?: 1 | 2 | 3) => object;
}

function makeShadow(isDark: boolean) {
  return (level: 1 | 2 | 3 = 1) => {
    if (isDark) {
      return {
        shadowColor: '#000',
        shadowOpacity: 0.34 + level * 0.06,
        shadowRadius: level * 9,
        shadowOffset: { width: 0, height: level * 4 },
        elevation: level * 4,
      };
    }
    return {
      shadowColor: '#093D2F',
      shadowOpacity: 0.05 + level * 0.03,
      shadowRadius: level * 9,
      shadowOffset: { width: 0, height: level * 3 },
      elevation: level * 3,
    };
  };
}

export function useTheme(): Theme {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  return {
    colors: isDark ? darkColors : lightColors,
    hero: isDark ? darkHero : lightHero,
    spacing,
    radius,
    fontSize,
    fontWeight,
    fonts,
    isDark,
    shadow: makeShadow(isDark),
  };
}

export const colors = { light: lightColors, dark: darkColors, palette };
