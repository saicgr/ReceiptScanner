/**
 * GPS trip logging — fully on-device (no per-use API cost).
 *
 * Uses `expo-location` `watchPositionAsync` to stream position updates while a
 * trip is active. Each new fix is converted into incremental distance with the
 * haversine formula and accumulated; the running total (in miles) is pushed to
 * the caller via `onUpdate` so the UI can show a live counter. When the trip
 * stops we tear down the subscription and hand back the total distance plus the
 * full path so it can be persisted (`path_json`) on a `MileageTrip`.
 *
 * Everything runs locally — GPS never leaves the device. `haversineMiles` is a
 * pure function exported for unit tests.
 */
import * as Location from 'expo-location';

/** A single recorded GPS sample: lat/lng plus the epoch-ms timestamp. */
export interface PathPoint {
  lat: number;
  lng: number;
  t: number;
}

const EARTH_RADIUS_MILES = 3958.8;

/**
 * Great-circle distance between two coordinates, in miles. Pure — no I/O — so
 * it can be unit-tested directly.
 */
export function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  // Clamp to guard against tiny floating-point overshoot beyond 1.
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return EARTH_RADIUS_MILES * c;
}

// ---------------------------------------------------------------------------
// Active-trip state (module singleton — only one trip can log at a time)
// ---------------------------------------------------------------------------

const METERS_PER_MILE = 1609.344;

/** Fixes with a reported accuracy worse than this are discarded outright —
 *  they would inject large jitter segments into the distance total. */
const MAX_ACCURACY_METERS = 50;

/** Minimum segment length we count. Stationary GPS noise produces tiny
 *  "movements"; anything below max(this, the fixes' own accuracy) is skipped
 *  WITHOUT advancing the anchor point, so genuine slow movement still
 *  accumulates until it exceeds the floor. */
const MIN_SEGMENT_METERS = 10;

let subscription: Location.LocationSubscription | null = null;
let path: PathPoint[] = [];
let distanceMiles = 0;
let lastPoint: PathPoint | null = null;
let lastAccuracy = 0;
// The live-update listener is replaceable so a remounted screen can re-attach
// to an in-flight trip instead of the watcher firing into a dead closure.
let onUpdateCallback: ((miles: number) => void) | null = null;

/** Discards any in-progress trip state. */
function resetState(): void {
  if (subscription) {
    subscription.remove();
    subscription = null;
  }
  path = [];
  distanceMiles = 0;
  lastPoint = null;
  lastAccuracy = 0;
  onUpdateCallback = null;
}

/** Whether a GPS trip is currently being logged (survives screen remounts). */
export function isTracking(): boolean {
  return subscription !== null;
}

/** The miles accumulated so far on the active trip (0 when idle). */
export function getLiveMiles(): number {
  return round2(distanceMiles);
}

/**
 * Replace (or detach, with `null`) the live-update listener. The Mileage screen
 * calls this on focus/blur so the singleton never holds a stale closure from an
 * unmounted component while the watcher keeps running in the background.
 */
export function setOnUpdate(cb: ((miles: number) => void) | null): void {
  onUpdateCallback = cb;
}

/**
 * Begin GPS trip logging. Requests foreground location permission, starts a
 * high-accuracy position watch, accumulates haversine distance between fixes
 * and reports the running total (miles) through `onUpdate`.
 *
 * @returns `true` if tracking started, `false` if permission was denied or the
 *          platform has no location support (gracefully, never throws).
 */
export async function startTracking(
  onUpdate: (miles: number) => void,
): Promise<boolean> {
  // Tearing down anything stale guarantees a clean trip and one subscription.
  resetState();
  onUpdateCallback = onUpdate;

  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      return false;
    }

    subscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        // Emit roughly every 5s or every ~10m, whichever comes first, to keep
        // the path detailed enough for accurate distance without flooding.
        timeInterval: 5000,
        distanceInterval: 10,
      },
      (location) => {
        // Discard low-quality fixes outright — a 100m-accuracy fix can "move"
        // the position by a city block while the user is standing still.
        const accuracy = location.coords.accuracy;
        if (typeof accuracy === 'number' && accuracy > MAX_ACCURACY_METERS) {
          return;
        }
        const point: PathPoint = {
          lat: location.coords.latitude,
          lng: location.coords.longitude,
          t: location.timestamp,
        };
        if (lastPoint) {
          // Noise floor: skip segments shorter than the worse of the two
          // fixes' accuracies (or MIN_SEGMENT_METERS). The anchor point is NOT
          // advanced on a skip, so slow real movement still adds up once it
          // clears the floor — only back-and-forth jitter is dropped.
          const segmentMeters =
            haversineMiles(lastPoint, point) * METERS_PER_MILE;
          const floor = Math.max(MIN_SEGMENT_METERS, lastAccuracy, accuracy ?? 0);
          if (segmentMeters < floor) return;
          distanceMiles += segmentMeters / METERS_PER_MILE;
        }
        lastPoint = point;
        lastAccuracy = typeof accuracy === 'number' ? accuracy : 0;
        path.push(point);
        onUpdateCallback?.(round2(distanceMiles));
      },
    );

    return true;
  } catch {
    // watchPositionAsync / permission lookups can reject on web or when the
    // location provider is unavailable — degrade gracefully.
    resetState();
    return false;
  }
}

/**
 * Stop the active trip, remove the watch subscription, and return the total
 * distance (miles, rounded) together with the recorded path. Idempotent: safe
 * to call when no trip is active (or twice in a row) — subsequent calls return
 * a zero-distance empty path and touch nothing.
 */
export async function stopTracking(): Promise<{
  distanceMiles: number;
  path: PathPoint[];
}> {
  const result = {
    distanceMiles: round2(distanceMiles),
    path: [...path],
  };
  resetState();
  return result;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
