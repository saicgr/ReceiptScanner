/**
 * Stable per-install device id (used for backend rate limiting + deriving the
 * email forwarding token). Persisted in AsyncStorage; generated once.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { newId } from './id';

const KEY = 'receiptsnap.deviceId';
let cached: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  let id = await AsyncStorage.getItem(KEY);
  if (!id) {
    id = newId();
    await AsyncStorage.setItem(KEY, id);
  }
  cached = id;
  return id;
}

/**
 * Derive the email forwarding token from the device id, EXACTLY matching the
 * backend's `sha256(deviceId).slice(0,10)` so the address shown in the app
 * routes correctly. Uses expo-crypto's async SHA-256. The canonical value still
 * comes from GET /forwarding-address; this is the offline fallback.
 */
export async function forwardingTokenFromDeviceId(
  deviceId: string,
): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    deviceId,
  );
  return digest.slice(0, 10);
}
