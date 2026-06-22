/**
 * billingService — one-time in-app purchase that unlocks ReceiptSnap.
 *
 * ReceiptSnap is a ONE-TIME-PURCHASE app: no subscriptions, no ads. There is a
 * single non-consumable product (`appConfig.iapProductId`, default
 * `receiptsnap_unlock`, listed at `$9.99`) that lifts the free-scan cap and
 * unlocks export + cloud backup.
 *
 * Implementation notes / contract:
 *  - Uses `react-native-iap` (v12 API: initConnection / getProducts /
 *    requestPurchase / finishTransaction / getAvailablePurchases).
 *  - On a successful purchase OR restore we flip the local entitlement by
 *    calling `useSettings.getState().update({ is_unlocked: true })`, which
 *    persists to SQLite and updates every screen reactively.
 *  - EVERY react-native-iap call is wrapped in try/catch. The store is only
 *    available on real devices with a billing client (App Store / Play Store),
 *    so on simulators / Expo Go / web we degrade gracefully and return a clear,
 *    human-readable message instead of throwing. We never crash the app over a
 *    billing failure.
 */
import { Platform } from 'react-native';
import { appConfig } from '@/lib/config';
import { useSettings } from '@/store/settings';

/** Public shape returned to the paywall screen for rendering the product. */
export interface BillingProduct {
  id: string;
  price: string;
  title: string;
}

/**
 * react-native-iap is a native module. Requiring it can throw under Expo Go /
 * web / simulators where the native side isn't linked, so we load it lazily and
 * defensively. `Iap` is `null` when unavailable; callers fall back to a clear
 * message. Typed loosely on purpose — we only touch the documented surface.
 */
type IapModule = typeof import('react-native-iap');
let iapCache: IapModule | null | undefined; // undefined = not yet attempted

function loadIap(): IapModule | null {
  if (iapCache !== undefined) return iapCache;
  try {
    // Lazy require so a missing/native-only module never breaks module load.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    iapCache = require('react-native-iap') as IapModule;
  } catch {
    iapCache = null;
  }
  return iapCache;
}

/** A friendly message used everywhere the store isn't reachable. */
const NO_STORE_MESSAGE =
  Platform.OS === 'web'
    ? 'In-app purchases are not available on web. Please use the iOS or Android app.'
    : 'The store is unavailable here. In-app purchases require a real device with the App Store or Play Store signed in (they do not work on simulators).';

/** Normalize an unknown thrown value into a readable string. */
function errMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown error';
}

/**
 * Open the billing connection. Returns the live module on success or `null`
 * when the store cannot be reached (simulator / web / not linked). Always safe
 * to call repeatedly; react-native-iap dedupes the underlying connection.
 */
async function connect(): Promise<IapModule | null> {
  const Iap = loadIap();
  if (!Iap) return null;
  try {
    await Iap.initConnection();
    return Iap;
  } catch {
    // initConnection throws on simulators / unsupported environments.
    return null;
  }
}

/** Best-effort teardown; never throws. */
async function disconnect(Iap: IapModule | null): Promise<void> {
  if (!Iap) return;
  try {
    await Iap.endConnection();
  } catch {
    // Ignore — closing a connection should never surface an error to the user.
  }
}

/**
 * Fetch the purchasable products. Returns an empty array (rather than throwing)
 * whenever the store is unavailable, so the paywall can still render its static
 * benefits + fall back to the configured `$9.99` label.
 */
export async function getProducts(): Promise<BillingProduct[]> {
  const Iap = await connect();
  if (!Iap) return [];
  try {
    // v12 signature: getProducts({ skus }). Older builds accepted a bare array,
    // so we pass the object form which is the documented current API.
    const products = await Iap.getProducts({ skus: [appConfig.iapProductId] });
    return (products ?? []).map((p: any) => ({
      id: String(p?.productId ?? appConfig.iapProductId),
      // localizedPrice is the store-formatted price; fall back to our label.
      price: String(p?.localizedPrice ?? p?.price ?? appConfig.iapPriceLabel),
      title: String(p?.title ?? 'Unlock ReceiptSnap'),
    }));
  } catch {
    return [];
  } finally {
    await disconnect(Iap);
  }
}

/** Persist the unlocked entitlement locally (SQLite + reactive store). */
async function grantUnlock(): Promise<void> {
  try {
    await useSettings.getState().update({ is_unlocked: true });
  } catch {
    // The purchase succeeded even if the local write hiccuped; restorePurchases
    // can recover the entitlement later. Swallow so we don't report failure.
  }
}

/**
 * Run the one-time unlock purchase flow.
 *
 * On success we finish the transaction (acknowledge to the store so it isn't
 * refunded) and flip `is_unlocked`. Returns a result object — never throws — so
 * the paywall can show an inline message.
 */
export async function purchaseUnlock(): Promise<{ ok: boolean; message: string }> {
  const Iap = await connect();
  if (!Iap) return { ok: false, message: NO_STORE_MESSAGE };
  try {
    // v12: requestPurchase({ sku }) on iOS, { skus } on Android. Passing both
    // covered keys keeps it cross-platform without branching the happy path.
    const result: any = await Iap.requestPurchase({
      sku: appConfig.iapProductId,
      skus: [appConfig.iapProductId],
    } as any);

    // requestPurchase may resolve to a single purchase or an array of them.
    const purchases: any[] = Array.isArray(result)
      ? result
      : result
      ? [result]
      : [];

    if (purchases.length === 0) {
      // No purchase object returned — treat as a (likely user-) cancellation.
      return { ok: false, message: 'Purchase did not complete.' };
    }

    // Acknowledge/consume each purchase. A non-consumable unlock should NOT be
    // consumed, so isConsumable=false lets the user restore it on new devices.
    for (const purchase of purchases) {
      try {
        await Iap.finishTransaction({ purchase, isConsumable: false });
      } catch {
        // Even if acknowledgement fails the entitlement is valid locally; the
        // store will resurface unacknowledged purchases on the next launch.
      }
    }

    await grantUnlock();
    return { ok: true, message: 'Thanks! ReceiptSnap is now fully unlocked.' };
  } catch (e: unknown) {
    const message = errMessage(e);
    // react-native-iap surfaces user cancellation with code E_USER_CANCELLED.
    if (/cancel/i.test(message) || /E_USER_CANCELLED/i.test(message)) {
      return { ok: false, message: 'Purchase cancelled.' };
    }
    return { ok: false, message: `Purchase failed: ${message}` };
  } finally {
    await disconnect(Iap);
  }
}

/**
 * Restore a previous one-time purchase (e.g. on a new device or reinstall).
 * If any available purchase matches our product id, re-grant the unlock.
 */
export async function restorePurchases(): Promise<{ ok: boolean; message: string }> {
  const Iap = await connect();
  if (!Iap) return { ok: false, message: NO_STORE_MESSAGE };
  try {
    const purchases: any[] = (await Iap.getAvailablePurchases()) ?? [];
    const matched = purchases.some(
      (p) => String(p?.productId) === appConfig.iapProductId,
    );

    if (matched) {
      await grantUnlock();
      return { ok: true, message: 'Purchase restored — ReceiptSnap is unlocked.' };
    }
    return {
      ok: false,
      message: 'No previous purchase found for this account.',
    };
  } catch (e: unknown) {
    return { ok: false, message: `Restore failed: ${errMessage(e)}` };
  } finally {
    await disconnect(Iap);
  }
}
