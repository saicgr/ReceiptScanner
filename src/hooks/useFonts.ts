/**
 * Loads the VAULT type families (Fraunces display + Hanken Grotesk UI) once at
 * startup. Registered under their exact per-weight names so the theme can
 * reference e.g. `Fraunces_600SemiBold` directly. Resolves (never rejects) so a
 * font hiccup degrades to system fonts rather than blocking the splash.
 */
import * as Font from 'expo-font';
import {
  Fraunces_500Medium,
  Fraunces_600SemiBold,
  Fraunces_700Bold,
} from '@expo-google-fonts/fraunces';
import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
  HankenGrotesk_800ExtraBold,
} from '@expo-google-fonts/hanken-grotesk';

export async function loadAppFonts(): Promise<void> {
  try {
    await Font.loadAsync({
      Fraunces_500Medium,
      Fraunces_600SemiBold,
      Fraunces_700Bold,
      HankenGrotesk_400Regular,
      HankenGrotesk_500Medium,
      HankenGrotesk_600SemiBold,
      HankenGrotesk_700Bold,
      HankenGrotesk_800ExtraBold,
    });
  } catch {
    /* fall back to system fonts */
  }
}
