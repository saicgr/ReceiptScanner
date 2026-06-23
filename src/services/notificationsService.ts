/**
 * notificationsService — local notifications (expo-notifications) for the V2
 * warranty / return-window reminders. Everything here runs fully on-device; no
 * push servers and no network calls.
 *
 * Strategy:
 *  - We schedule a *date-trigger* notification N days before each deadline
 *    (`returnDaysBefore` before the return deadline, `warrantyDaysBefore` before
 *    the warranty deadline). If that computed fire-date is already in the past
 *    we simply skip it — there is no point alerting after the window closed.
 *  - The scheduled notification ids are stored in AsyncStorage under the key
 *    `notif:<receiptId>` so we can cancel them when the receipt is edited or
 *    deleted (re-scheduling first cancels the previous batch).
 *
 * Every native call is wrapped defensively: on web / unsupported platforms (or
 * when permission is denied) expo-notifications is a no-op and we degrade
 * gracefully rather than throwing into the calling service.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type * as NotificationsModule from 'expo-notifications';

import { addDays, daysUntil, formatDate, relativeDays } from '@/lib/dates';

/**
 * `expo-notifications` is loaded lazily and ONLY where it actually works.
 *
 * In Expo Go (SDK 53+) remote-notification support was removed and merely
 * importing the module logs a scary error on Android. We're a local-reminder
 * app, but to avoid that noise — and to degrade cleanly on web — we never load
 * the module in Expo Go or on web. Reminders simply no-op there; a development
 * build gets the full experience. `getNotifications()` returns the module or
 * null, and every public function bails when it's null.
 */
const isExpoGo = Constants.executionEnvironment === 'storeClient';
let cachedModule: typeof NotificationsModule | null | undefined;
function getNotifications(): typeof NotificationsModule | null {
  if (cachedModule !== undefined) return cachedModule;
  if (Platform.OS === 'web' || isExpoGo) {
    cachedModule = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedModule = require('expo-notifications') as typeof NotificationsModule;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/** AsyncStorage key holding the JSON array of notification ids for a receipt. */
function storageKey(receiptId: string): string {
  return `notif:${receiptId}`;
}

/** Fire at 9am local time on the trigger day so reminders aren't at midnight. */
const REMINDER_HOUR = 9;

/**
 * Configure how notifications behave while the app is foregrounded. Call once
 * (e.g. from the root layout). Safe to call on any platform.
 */
export function configureNotificationHandler(): void {
  const Notifications = getNotifications();
  if (!Notifications) return;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
        // iOS 14+ granular flags (ignored on older SDKs / Android).
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  } catch {
    // Notifications unavailable on this platform — nothing to configure.
  }
}

/**
 * Request notification permission, returning whether it is granted. On web the
 * module is a no-op, so we report `false` and callers skip scheduling.
 */
export async function ensurePermissions(): Promise<boolean> {
  const Notifications = getNotifications();
  if (!Notifications) return false;
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    // Some platforms grant provisionally — honour that too.
    if (current.status === 'granted') return true;
    if (!current.canAskAgain && current.status === 'denied') return false;
    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted || requested.status === 'granted';
  } catch {
    return false;
  }
}

/**
 * Build the Date a reminder should fire: `daysBefore` ahead of the deadline, at
 * the local reminder hour. Returns null when the deadline is unusable or when
 * the resulting fire-time is already in the past (skip stale reminders).
 */
function reminderFireDate(deadlineIso: string, daysBefore: number): Date | null {
  const before = Number.isFinite(daysBefore) ? Math.max(0, Math.trunc(daysBefore)) : 0;
  const triggerIso = addDays(deadlineIso, -before);
  // `daysUntil` is negative once the trigger day has passed.
  if (daysUntil(triggerIso) < 0) return null;

  const parts = triggerIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return null;
  const fire = new Date(+parts[1], +parts[2] - 1, +parts[3], REMINDER_HOUR, 0, 0, 0);
  // Guard against the trigger being today but the hour already elapsed.
  if (fire.getTime() <= Date.now()) return null;
  return fire;
}

/** Schedule a single date-trigger notification; returns its id or null. */
async function scheduleAt(
  fireDate: Date,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const Notifications = getNotifications();
  if (!Notifications) return null;
  try {
    const id = await Notifications.scheduleNotificationAsync({
      content: { title, body, data },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: fireDate,
      },
    });
    return id;
  } catch {
    return null;
  }
}

/**
 * Schedule the protection reminders for a receipt and persist their ids.
 *
 * Re-scheduling is idempotent: any previously scheduled reminders for this
 * receipt are cancelled first, so calling this after every save keeps the OS
 * queue in sync with the latest deadlines.
 *
 * @returns the list of newly scheduled notification ids (empty when nothing
 *          could/needed to be scheduled).
 */
export async function scheduleProtectionReminders(
  receipt: { id: string; vendor: string },
  opts: {
    returnDeadline?: string | null;
    warrantyDeadline?: string | null;
    itemName?: string;
    returnDaysBefore: number;
    warrantyDaysBefore: number;
  },
): Promise<string[]> {
  // Always clear the previous batch so we never leak duplicate reminders.
  await cancelReceiptReminders(receipt.id);

  const granted = await ensurePermissions();
  if (!granted) return [];

  const label = opts.itemName?.trim() || receipt.vendor?.trim() || 'your purchase';
  const ids: string[] = [];

  // ---- Return window reminder ----
  if (opts.returnDeadline) {
    const fire = reminderFireDate(opts.returnDeadline, opts.returnDaysBefore);
    if (fire) {
      const when = relativeDays(opts.returnDeadline);
      const id = await scheduleAt(
        fire,
        'Return window closing soon',
        `Return window for ${label} closes ${when} (${formatDate(opts.returnDeadline)}).`,
        { receiptId: receipt.id, kind: 'return', deadline: opts.returnDeadline },
      );
      if (id) ids.push(id);
    }
  }

  // ---- Warranty reminder ----
  if (opts.warrantyDeadline) {
    const fire = reminderFireDate(opts.warrantyDeadline, opts.warrantyDaysBefore);
    if (fire) {
      const when = relativeDays(opts.warrantyDeadline);
      const id = await scheduleAt(
        fire,
        'Warranty expiring soon',
        `Warranty for ${label} expires ${when} (${formatDate(opts.warrantyDeadline)}).`,
        { receiptId: receipt.id, kind: 'warranty', deadline: opts.warrantyDeadline },
      );
      if (id) ids.push(id);
    }
  }

  if (ids.length > 0) {
    try {
      await AsyncStorage.setItem(storageKey(receipt.id), JSON.stringify(ids));
    } catch {
      // Persisting the mapping failed — the reminders are still scheduled, but
      // we may not be able to cancel them precisely later. Non-fatal.
    }
  }

  return ids;
}

/**
 * Generic deadline reminders for any tracked entity (rebates, price-protection
 * claims, …). Mirrors the receipt-protection scheduler but keyed by an arbitrary
 * `entityKey` so each feature owns its own AsyncStorage namespace and cancel
 * scope. Schedules one date-trigger per provided deadline `daysBefore` ahead,
 * skipping past fire-dates. Re-scheduling first cancels the previous batch.
 *
 * @returns the newly scheduled notification ids.
 */
export async function scheduleDeadlineReminders(
  entityKey: string,
  reminders: {
    deadline: string | null;
    daysBefore: number;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }[],
): Promise<string[]> {
  await cancelEntityReminders(entityKey);

  const granted = await ensurePermissions();
  if (!granted) return [];

  const ids: string[] = [];
  for (const r of reminders) {
    if (!r.deadline) continue;
    const fire = reminderFireDate(r.deadline, r.daysBefore);
    if (!fire) continue;
    const id = await scheduleAt(fire, r.title, r.body, {
      entityKey,
      deadline: r.deadline,
      ...(r.data ?? {}),
    });
    if (id) ids.push(id);
  }

  if (ids.length > 0) {
    try {
      await AsyncStorage.setItem(entityKey, JSON.stringify(ids));
    } catch {
      // Non-fatal: reminders are scheduled, just not precisely cancelable later.
    }
  }
  return ids;
}

/** Cancel every reminder scheduled under a generic entity key. */
export async function cancelEntityReminders(entityKey: string): Promise<void> {
  await cancelByKey(entityKey);
}

/**
 * Cancel every reminder previously scheduled for a receipt and clear its
 * AsyncStorage mapping. Safe to call for receipts with no reminders.
 */
export async function cancelReceiptReminders(receiptId: string): Promise<void> {
  await cancelByKey(storageKey(receiptId));
}

/** Shared cancel routine: read the id list at `key`, cancel each, clear the key. */
async function cancelByKey(key: string): Promise<void> {
  let ids: string[] = [];
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        ids = parsed.filter((x): x is string => typeof x === 'string');
      }
    }
  } catch {
    // Corrupt / missing mapping — nothing reliable to cancel.
    ids = [];
  }

  const Notifications = getNotifications();
  for (const id of ids) {
    try {
      await Notifications?.cancelScheduledNotificationAsync(id);
    } catch {
      // Already fired or unknown id — ignore and keep cancelling the rest.
    }
  }

  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // Mapping removal failed — harmless; it will be overwritten on next schedule.
  }
}
