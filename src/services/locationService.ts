/**
 * Current-device location for geotagging a capture — fully on-device, no API.
 *
 * Mirrors the permission pattern used by `mileageService` (foreground-only
 * `requestForegroundPermissionsAsync` + `getCurrentPositionAsync`). It is the
 * fallback for receipt geotagging: when an imported/captured photo has no EXIF
 * GPS but the user has opted in (Settings → "Tag receipts with location"), we
 * read a single position fix here.
 *
 * Every path degrades gracefully — a denied permission, an unavailable provider,
 * or running on web all resolve to `null` rather than throwing, so a scan is
 * never blocked by location.
 */
import * as Location from 'expo-location';

/** A single position fix in signed decimal degrees. */
export interface DeviceCoords {
  lat: number;
  lng: number;
}

/**
 * Resolve the current device coordinates, requesting foreground-location
 * permission if needed. Returns `null` when permission is denied or location is
 * unavailable — never rejects.
 */
export async function getCurrentCoords(): Promise<DeviceCoords | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;

    const fix = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    const { latitude, longitude } = fix.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { lat: latitude, lng: longitude };
  } catch {
    // Permission lookup / position fetch can reject on web or when the provider
    // is unavailable — degrade to "no location".
    return null;
  }
}
