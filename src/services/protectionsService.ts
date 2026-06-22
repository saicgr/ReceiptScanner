/**
 * protectionsService — powers the Protections tab.
 *
 * V2 lets every receipt (and individual line item) carry a return window and/or
 * a warranty period. When those are set, the DAO precomputes `return_deadline`
 * and `warranty_deadline` (ISO dates). This service flattens all of those live
 * deadlines into a single, soonest-first `ProtectionEntry[]` so the UI can show
 * "what's expiring next" across the whole library without re-deriving any math.
 *
 * Each receipt/line-item can contribute up to two entries (one `return`, one
 * `warranty`). We surface BOTH receipt-level protections (e.g. a whole order's
 * 30-day return window) AND item-level protections (e.g. one product's 1-year
 * warranty), and tag each entry with the deadline owner's vendor + item name.
 */
import { getDb } from '@/db';
import { daysUntil } from '@/lib/dates';
import type { ProtectionEntry, ProtectionStatus } from '@/types';

/** Row shape for the receipt-level deadline query. */
interface ReceiptDeadlineRow {
  id: string;
  vendor: string | null;
  return_deadline: string | null;
  warranty_deadline: string | null;
  protection_status: string | null;
}

/** Row shape for the line-item-level deadline query (joined to its receipt). */
interface LineItemDeadlineRow {
  id: string;
  receipt_id: string;
  name: string | null;
  vendor: string | null; // parent receipt vendor
  return_deadline: string | null;
  warranty_deadline: string | null;
  protection_status: string | null;
  serial_number: string | null;
  product_photo_uri: string | null;
}

/**
 * Build the full Protections list: every receipt and line item that still has a
 * non-null return and/or warranty deadline, expanded into one entry per
 * deadline, with `daysRemaining` (negative when already past) and sorted
 * soonest-first so imminent deadlines float to the top.
 *
 * Returns an empty array if anything goes wrong (the tab simply shows its empty
 * state) — this is a read-only view and must never crash the app.
 */
export async function listProtections(): Promise<ProtectionEntry[]> {
  try {
    const db = await getDb();

    // Receipt-level protections: a whole-receipt return/warranty window.
    const receiptRows = await db.getAllAsync<ReceiptDeadlineRow>(
      `SELECT id, vendor, return_deadline, warranty_deadline, protection_status
         FROM receipts
        WHERE return_deadline IS NOT NULL
           OR warranty_deadline IS NOT NULL`,
    );

    // Line-item-level protections: per-product return/warranty windows. Joined
    // to the parent receipt so we can show the vendor alongside the item name.
    const itemRows = await db.getAllAsync<LineItemDeadlineRow>(
      `SELECT li.id            AS id,
              li.receipt_id     AS receipt_id,
              li.name           AS name,
              r.vendor          AS vendor,
              li.return_deadline AS return_deadline,
              li.warranty_deadline AS warranty_deadline,
              li.protection_status AS protection_status,
              li.serial_number  AS serial_number,
              li.product_photo_uri AS product_photo_uri
         FROM line_items li
         JOIN receipts r ON r.id = li.receipt_id
        WHERE li.return_deadline IS NOT NULL
           OR li.warranty_deadline IS NOT NULL`,
    );

    const entries: ProtectionEntry[] = [];

    for (const row of receiptRows) {
      const vendor = row.vendor ?? '';
      const status = normalizeStatus(row.protection_status);
      // Receipt-level entries describe the whole receipt, so the "item" label
      // is the vendor name itself (per the ProtectionEntry contract).
      pushEntry(entries, {
        kind: 'return',
        receiptId: row.id,
        lineItemId: null,
        vendor,
        itemName: vendor,
        deadline: row.return_deadline,
        status,
        serialNumber: null,
        productPhotoUri: null,
      });
      pushEntry(entries, {
        kind: 'warranty',
        receiptId: row.id,
        lineItemId: null,
        vendor,
        itemName: vendor,
        deadline: row.warranty_deadline,
        status,
        serialNumber: null,
        productPhotoUri: null,
      });
    }

    for (const row of itemRows) {
      const vendor = row.vendor ?? '';
      const itemName = row.name ?? vendor;
      const status = normalizeStatus(row.protection_status);
      pushEntry(entries, {
        kind: 'return',
        receiptId: row.receipt_id,
        lineItemId: row.id,
        vendor,
        itemName,
        deadline: row.return_deadline,
        status,
        serialNumber: row.serial_number,
        productPhotoUri: row.product_photo_uri,
      });
      pushEntry(entries, {
        kind: 'warranty',
        receiptId: row.receipt_id,
        lineItemId: row.id,
        vendor,
        itemName,
        deadline: row.warranty_deadline,
        status,
        serialNumber: row.serial_number,
        productPhotoUri: row.product_photo_uri,
      });
    }

    // Soonest deadline first (smallest daysRemaining, past dates lead). Ties
    // broken by item name for a stable, readable ordering.
    entries.sort(
      (a, b) =>
        a.daysRemaining - b.daysRemaining ||
        a.itemName.localeCompare(b.itemName),
    );

    return entries;
  } catch (err) {
    // Read-only view — degrade to an empty list rather than throwing.
    console.warn('[protectionsService] listProtections failed', err);
    return [];
  }
}

/**
 * Append a ProtectionEntry only when its deadline is present, computing
 * `daysRemaining` from today. Keeps the two callers above free of null checks.
 */
function pushEntry(
  out: ProtectionEntry[],
  e: Omit<ProtectionEntry, 'deadline' | 'daysRemaining'> & {
    deadline: string | null;
  },
): void {
  if (!e.deadline) return;
  out.push({
    kind: e.kind,
    receiptId: e.receiptId,
    lineItemId: e.lineItemId,
    vendor: e.vendor,
    itemName: e.itemName,
    deadline: e.deadline,
    daysRemaining: daysUntil(e.deadline),
    status: e.status,
    serialNumber: e.serialNumber,
    productPhotoUri: e.productPhotoUri,
  });
}

/** Coerce a raw DB string into a valid ProtectionStatus (defaults to 'none'). */
function normalizeStatus(raw: string | null): ProtectionStatus {
  switch (raw) {
    case 'return_active':
    case 'return_expired':
    case 'warranty_active':
    case 'warranty_expired':
    case 'none':
      return raw;
    default:
      return 'none';
  }
}
