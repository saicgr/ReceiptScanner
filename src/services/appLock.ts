/**
 * ReceiptSnap — App Lock service.
 *
 * Provides a thin, defensive wrapper around `expo-local-authentication` used to
 * gate the History & Statistics screens when the user enables `settings.app_lock`.
 *
 * Design principle: FAIL OPEN.
 * Biometrics/PIN are a convenience guard, not a vault. If the device has no
 * supported hardware, the user hasn't enrolled any biometrics/passcode, or the
 * native module is unavailable (e.g. web), we must never permanently lock the
 * user out of their own offline-first data. In every such case we return `true`
 * (treat as authenticated) and never throw.
 *
 * Screens/layout call `authenticate()` on focus when `app_lock` is on; they may
 * call `isBiometricAvailable()` first (e.g. in Settings) to decide whether to
 * offer the toggle.
 */
import * as LocalAuthentication from 'expo-local-authentication';

/**
 * True when the device has supported biometric hardware AND the user has
 * enrolled at least one biometric/passcode. Useful for the Settings screen to
 * decide whether enabling the App Lock toggle is meaningful.
 *
 * Never throws — any native/web error resolves to `false`.
 */
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    return hasHardware && isEnrolled;
  } catch {
    // Native module missing / web / any unexpected error -> not available.
    return false;
  }
}

/**
 * Prompt the user to authenticate via biometrics or device passcode.
 *
 * Returns `true` when:
 *  - authentication succeeds, OR
 *  - the device has no supported hardware or no enrolled credentials (fail-open
 *    so the user is never locked out of their own data), OR
 *  - the native module is unavailable / throws.
 *
 * Returns `false` only when hardware + enrollment exist but the user fails or
 * cancels the prompt. Never throws.
 *
 * @param reason Message shown in the system auth prompt.
 */
export async function authenticate(reason = 'Unlock ReceiptSnap'): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    // Fail open: nothing to authenticate against -> allow access.
    if (!hasHardware || !isEnrolled) return true;

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      // Allow the device passcode as a fallback so users aren't stuck if a
      // biometric read fails repeatedly.
      disableDeviceFallback: false,
      cancelLabel: 'Cancel',
    });
    return result.success;
  } catch {
    // If the native call throws (module unavailable, etc.) fail open.
    return true;
  }
}
