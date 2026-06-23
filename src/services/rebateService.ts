/**
 * rebateService (TASK 81) — mail-in rebate tracking. Thin orchestration over the
 * rebates DAO that also (re)schedules local reminders for the submission and
 * payout deadlines via the shared notification infra. All on-device.
 *
 * Reminders reuse notificationsService.scheduleDeadlineReminders under a
 * per-rebate entity key so editing/deleting a rebate cleans up its reminders.
 */
import * as DB from '@/db';
import { getAllSettings } from '@/db/settings';
import { formatDate, relativeDays } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { Rebate } from '@/types';
import {
  scheduleDeadlineReminders,
  cancelEntityReminders,
} from './notificationsService';

/** AsyncStorage / notification namespace for a rebate's reminders. */
function rebateKey(id: string): string {
  return `rebate-notif:${id}`;
}

/** (Re)schedule submission + payout reminders for a rebate. Best-effort. */
async function scheduleRebateReminders(rebate: Rebate): Promise<void> {
  const settings = await getAllSettings();
  const label = rebate.description?.trim() || rebate.vendor?.trim() || 'your rebate';
  const amount = formatMoney(rebate.amount, rebate.currency);
  try {
    await scheduleDeadlineReminders(rebateKey(rebate.id), [
      {
        deadline: rebate.status === 'pending' ? rebate.submission_deadline : null,
        daysBefore: settings.notify_return_days_before,
        title: 'Rebate submission closing',
        body: `Submit the ${amount} rebate for ${label} ${
          rebate.submission_deadline ? relativeDays(rebate.submission_deadline) : 'soon'
        }${rebate.submission_deadline ? ` (${formatDate(rebate.submission_deadline)})` : ''}.`,
        data: { rebateId: rebate.id, kind: 'rebate_submit' },
      },
      {
        deadline: rebate.status === 'submitted' ? rebate.payout_deadline : null,
        daysBefore: settings.notify_warranty_days_before,
        title: 'Rebate payout overdue?',
        body: `The ${amount} rebate for ${label} should have arrived by ${
          rebate.payout_deadline ? formatDate(rebate.payout_deadline) : 'now'
        }. Follow up if it hasn’t.`,
        data: { rebateId: rebate.id, kind: 'rebate_payout' },
      },
    ]);
  } catch {
    // Reminders are a nice-to-have; never block the data write.
  }
}

export async function listRebates(): Promise<Rebate[]> {
  return DB.Rebates.listRebates();
}

export async function listRebatesForReceipt(receiptId: string): Promise<Rebate[]> {
  return DB.Rebates.listRebatesForReceipt(receiptId);
}

export async function createRebate(input: Partial<Rebate>): Promise<Rebate> {
  const rebate = await DB.Rebates.createRebate(input);
  await scheduleRebateReminders(rebate);
  return rebate;
}

export async function updateRebate(id: string, patch: Partial<Rebate>): Promise<void> {
  await DB.Rebates.updateRebate(id, patch);
  const updated = await DB.Rebates.getRebate(id);
  if (updated) await scheduleRebateReminders(updated);
}

export async function deleteRebate(id: string): Promise<void> {
  try {
    await cancelEntityReminders(rebateKey(id));
  } catch {
    // best-effort
  }
  await DB.Rebates.deleteRebate(id);
}
