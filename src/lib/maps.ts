/**
 * Pure helpers for displaying a receipt's capture location.
 *
 * No `react-native-maps`: that package needs native (Google Maps SDK / API key)
 * configuration this managed app deliberately doesn't bundle, so the receipt
 * detail renders a static coordinate card plus an "Open in Maps" deep link that
 * hands off to the device's own maps app. These helpers build that link and
 * format the coordinates; they are I/O-free so they unit-test directly.
 */

/** A latitude/longitude pair, in signed decimal degrees. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Valid finite lat in [-90,90] and lng in [-180,180]. */
export function hasValidCoords(
  lat: number | null | undefined,
  lng: number | null | undefined,
): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/**
 * Human-readable coordinate string, e.g. "37.42460° N, 122.08400° W".
 * Uses N/S/E/W hemisphere suffixes (so the sign is never ambiguous) and a fixed
 * 5-decimal precision (~1 m), which is plenty for a "where did I buy this".
 */
export function formatCoords(lat: number, lng: number, digits = 5): string {
  const latRef = lat >= 0 ? 'N' : 'S';
  const lngRef = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}° ${latRef}, ${Math.abs(lng).toFixed(digits)}° ${lngRef}`;
}

/**
 * Build a deep link that opens the coordinates in the device's native maps app.
 *
 * iOS gets an Apple Maps `https://maps.apple.com/?ll=` URL (which the OS routes
 * to the Maps app); every other platform gets a Google Maps
 * `https://www.google.com/maps/search/?api=1&query=` URL, which both the
 * Android Google Maps app and any browser understand. Using https URLs (rather
 * than the `geo:`/`maps:` schemes) means `Linking.openURL` succeeds even when a
 * dedicated maps app isn't installed — it falls back to the browser.
 *
 * @param platform  Pass `Platform.OS`; defaults to a web/Google link.
 * @param label     Optional pin label (e.g. the vendor name).
 */
export function mapsUrl(
  { lat, lng }: LatLng,
  platform: string = 'web',
  label?: string | null,
): string {
  // Coordinates only — fixed precision keeps the URL stable and tidy.
  const ll = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  if (platform === 'ios') {
    const q = label ? `&q=${encodeURIComponent(label)}` : '';
    return `https://maps.apple.com/?ll=${ll}${q}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${ll}`;
}
