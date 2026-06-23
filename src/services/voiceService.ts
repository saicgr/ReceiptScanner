/**
 * voiceService — hands-free assistance for field entry/correction (TASK 52).
 *
 * SCOPE / HONESTY:
 *  - Text-to-speech (speaking prompts aloud) is REAL, via the lightweight
 *    first-party `expo-speech` module. The import is wrapped defensively so the
 *    app never crashes if the native module isn't linked (e.g. on web or an old
 *    build) — speaking just no-ops in that case.
 *  - Speech-to-TEXT (dictation) is deliberately NOT implemented here: a reliable
 *    on-device STT engine needs a heavy native dependency, which the task
 *    explicitly says to avoid. `isDictationAvailable()` returns false and
 *    `dictateField()` is a clearly-labelled stub that returns null, so callers
 *    can show "coming soon" UI without pretending it works.
 *
 * Everything runs on-device — no network, no per-use cost.
 */

/** The subset of expo-speech we use, typed minimally to avoid a hard dep. */
interface SpeechModule {
  speak: (text: string, options?: Record<string, unknown>) => void;
  stop: () => void;
}

let cachedSpeech: SpeechModule | null | undefined;

/**
 * Lazily resolve expo-speech. Returns null when the module isn't installed/linked
 * so every caller degrades quietly. Cached after the first attempt.
 */
function getSpeech(): SpeechModule | null {
  if (cachedSpeech !== undefined) return cachedSpeech;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-speech') as SpeechModule;
    cachedSpeech = mod && typeof mod.speak === 'function' ? mod : null;
  } catch {
    cachedSpeech = null;
  }
  return cachedSpeech;
}

/** True when spoken prompts are actually available on this device/build. */
export function isSpeechAvailable(): boolean {
  return getSpeech() !== null;
}

/**
 * Speak a prompt aloud (best-effort). Respects `enabled` (the user's
 * voice_enabled setting) and silently no-ops when TTS is unavailable.
 */
export function speak(text: string, enabled: boolean): void {
  if (!enabled || !text.trim()) return;
  const speech = getSpeech();
  if (!speech) return;
  try {
    speech.speak(text, { rate: 1.0, pitch: 1.0 });
  } catch {
    // Never let a TTS hiccup affect the UI.
  }
}

/** Stop any in-progress speech (e.g. when leaving the screen). */
export function stopSpeaking(): void {
  const speech = getSpeech();
  if (!speech) return;
  try {
    speech.stop();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Speech-to-text — HONEST STUB (no heavy native STT dependency)
// ---------------------------------------------------------------------------

/** Always false: on-device dictation isn't wired (would need a heavy native dep). */
export function isDictationAvailable(): boolean {
  return false;
}

/**
 * Placeholder for dictating a single field's value. Returns null to signal "not
 * captured" so the caller keeps the typed value. Intentionally a stub — see the
 * scope note at the top of this file.
 */
export async function dictateField(_fieldLabel: string): Promise<string | null> {
  return null;
}
