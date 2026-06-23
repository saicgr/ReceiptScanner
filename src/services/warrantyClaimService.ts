/**
 * warrantyClaimService (TASK 80) — bundle everything a user needs to file a
 * warranty (or return) claim into a single shareable packet.
 *
 * A claim packet is generated entirely on-device (NO server): we produce a
 * self-contained HTML summary (vendor, purchase date, item, serial number,
 * warranty/return deadlines, proof-of-purchase reference) and hand it, the
 * retained ORIGINAL receipt image, and the optional product photo to the OS
 * share sheet in turn. The user can route those to email / Drive / the
 * manufacturer's claim portal from the sheet.
 *
 * Surfaced from the receipt detail (and indirectly the Protections list, which
 * deep-links to the receipt). Best-effort sharing: a missing image is simply
 * skipped, and a cancelled/unavailable share never throws.
 */
import * as FileSystem from 'expo-file-system/legacy';

import * as DB from '@/db';
import { getAllSettings } from '@/db/settings';
import { formatDate } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import type { LineItem, ReceiptWithRelations } from '@/types';
import { shareFile } from './exporters';

/** Escape user text for safe inline HTML. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CLAIM_DIR = `${FileSystem.cacheDirectory}claims/`;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(CLAIM_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(CLAIM_DIR, { intermediates: true });
  }
}

function safeStem(name: string): string {
  const slug = (name || 'claim')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug ? `claim-${slug}` : 'claim';
}

/**
 * Build the claim-packet HTML for a receipt, optionally focused on one line item
 * (its serial number / product photo / per-item deadlines take precedence). Pure
 * string builder so it can be reasoned about / reused.
 */
export function buildClaimHtml(
  receipt: ReceiptWithRelations,
  lineItem: LineItem | null,
  dateFormat: string,
): string {
  const itemName = lineItem?.name || receipt.vendor || 'Purchased item';
  const serial = lineItem?.serial_number ?? null;
  const returnDeadline = lineItem?.return_deadline ?? receipt.return_deadline;
  const warrantyDeadline = lineItem?.warranty_deadline ?? receipt.warranty_deadline;

  const row = (label: string, value: string) =>
    value
      ? `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`
      : '';

  const rows = [
    row('Item', itemName),
    row('Vendor', receipt.vendor),
    row('Purchase date', receipt.date ? formatDate(receipt.date, dateFormat) : ''),
    row('Amount paid', formatMoney(receipt.total, receipt.currency)),
    row('Serial number', serial ?? ''),
    row('Return window ends', returnDeadline ? formatDate(returnDeadline, dateFormat) : ''),
    row('Warranty ends', warrantyDeadline ? formatDate(warrantyDeadline, dateFormat) : ''),
    row('Saved file', receipt.saved_filename ?? ''),
    row('Proof-of-purchase ref', receipt.id),
  ]
    .filter(Boolean)
    .join('');

  const generatedOn = formatDate(new Date().toISOString().slice(0, 10), 'MMMM D, YYYY');

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Warranty Claim — ${esc(itemName)}</title>
    <style>
      * { font-family: -apple-system, Helvetica, Arial, sans-serif; }
      body { color: #0F172A; max-width: 640px; margin: 24px auto; padding: 0 16px; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      .sub { color: #64748B; font-size: 12px; margin: 0 0 20px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #E2E8F0; font-size: 13px; vertical-align: top; }
      th { width: 38%; color: #475569; font-weight: 600; }
      .note { color: #475569; font-size: 12px; margin-top: 20px; }
    </style></head>
    <body>
      <h1>Warranty / Return Claim Packet</h1>
      <p class="sub">Generated ${esc(generatedOn)} · ReceiptSnap</p>
      <table>${rows}</table>
      ${receipt.memo ? `<p class="note"><strong>Memo:</strong> ${esc(receipt.memo)}</p>` : ''}
      <p class="note">The original receipt image${
        lineItem?.product_photo_uri ? ' and a product photo are' : ' is'
      } shared alongside this summary as proof of purchase.</p>
    </body></html>`;
}

/**
 * Assemble and share a warranty-claim packet for a receipt (optionally a single
 * line item). Returns the uris that were shared (summary first, then any images).
 * Throws 'receipt-not-found' if the id can't be loaded.
 */
export async function shareWarrantyClaim(
  receiptId: string,
  lineItemId?: string | null,
): Promise<string[]> {
  const [receipt, settings] = await Promise.all([
    DB.getReceipt(receiptId),
    getAllSettings(),
  ]);
  if (!receipt) throw new Error('receipt-not-found');

  const lineItem = lineItemId
    ? receipt.line_items.find((li) => li.id === lineItemId) ?? null
    : null;

  await ensureDir();
  const html = buildClaimHtml(receipt, lineItem, settings.date_format);
  const stem = safeStem(lineItem?.name || receipt.vendor);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const summaryUri = `${CLAIM_DIR}${stem}-${stamp}.html`;
  await FileSystem.writeAsStringAsync(summaryUri, html, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  // Collect proof images: the retained original + an optional product photo.
  const imageUris: string[] = [];
  const original = receipt.original_image_uri ?? receipt.images[0]?.uri ?? null;
  if (original) imageUris.push(original);
  if (lineItem?.product_photo_uri) imageUris.push(lineItem.product_photo_uri);

  const shared: string[] = [summaryUri, ...imageUris];
  // Share each in turn; the OS share sheet handles one file at a time.
  for (const uri of shared) {
    await shareFile(uri);
  }
  return shared;
}
