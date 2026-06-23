/**
 * priceProtectionService (TASK 79) — price-drop / price-protection claim
 * reminders. Orchestration over the price_protections DAO that (re)schedules a
 * local reminder before the claim window closes. Fully on-device.
 */
import * as DB from '@/db';
import { getAllSettings } from '@/db/settings';
import { formatDate, relativeDays } from '@/lib/dates';
import { formatMoney, round2 } from '@/lib/money';
import type { PriceProtection } from '@/types';
import {
  scheduleDeadlineReminders,
  cancelEntityReminders,
} from './notificationsService';

function ppKey(id: string): string {
  return `priceprot-notif:${id}`;
}

/** The amount the user could reclaim (paid − current, floored at 0). */
export function claimableAmount(p: Pick<PriceProtection, 'original_price' | 'current_price'>): number {
  return round2(Math.max(0, p.original_price - p.current_price));
}

async function schedulePpReminders(p: PriceProtection): Promise<void> {
  const settings = await getAllSettings();
  const label = p.item_name?.trim() || p.vendor?.trim() || 'your purchase';
  const refund = formatMoney(claimableAmount(p), p.currency);
  try {
    await scheduleDeadlineReminders(ppKey(p.id), [
      {
        deadline: p.status === 'open' ? p.claim_deadline : null,
        daysBefore: settings.notify_return_days_before,
        title: 'Price-protection claim closing',
        body: `Claim the ${refund} price difference on ${label} ${
          p.claim_deadline ? relativeDays(p.claim_deadline) : 'soon'
        }${p.claim_deadline ? ` (${formatDate(p.claim_deadline)})` : ''}.`,
        data: { priceProtectionId: p.id, kind: 'price_protection' },
      },
    ]);
  } catch {
    // best-effort
  }
}

export async function listPriceProtections(): Promise<PriceProtection[]> {
  return DB.PriceProtections.listPriceProtections();
}

export async function listPriceProtectionsForReceipt(
  receiptId: string,
): Promise<PriceProtection[]> {
  return DB.PriceProtections.listPriceProtectionsForReceipt(receiptId);
}

export async function createPriceProtection(
  input: Partial<PriceProtection>,
): Promise<PriceProtection> {
  const p = await DB.PriceProtections.createPriceProtection(input);
  await schedulePpReminders(p);
  return p;
}

export async function updatePriceProtection(
  id: string,
  patch: Partial<PriceProtection>,
): Promise<void> {
  await DB.PriceProtections.updatePriceProtection(id, patch);
  const updated = await DB.PriceProtections.getPriceProtection(id);
  if (updated) await schedulePpReminders(updated);
}

export async function deletePriceProtection(id: string): Promise<void> {
  try {
    await cancelEntityReminders(ppKey(id));
  } catch {
    // best-effort
  }
  await DB.PriceProtections.deletePriceProtection(id);
}
