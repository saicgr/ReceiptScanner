// Inbound-email webhook handler.
//
// Your mail provider (SendGrid Inbound Parse, Mailgun Routes, Postmark, etc.) is
// configured to POST messages sent to *@<FORWARDING_DOMAIN> here. We:
//   1. Derive the user's forwarding token from the recipient address
//      (user-<token>@inbox.receiptsnap.app).
//   2. Run the email body and any PDF/image attachment through the SAME Gemini
//      extraction pipeline used by /extract.
//   3. Park the result in the ephemeral pending queue for the app to pull.
//
// No user receipt is persisted server-side beyond the short-lived queue.
import { createHash, timingSafeEqual } from 'node:crypto';
import { extractReceipt } from './gemini.js';
import { enqueue } from './pendingStore.js';
import { globalCheckAndConsume, globalRefund } from './rateLimit.js';
import { config } from './config.js';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

/** Each attachment is a billed Gemini call — process at most this many. */
const MAX_ATTACHMENTS_PER_EMAIL = 3;

/** Extract the token from "user-ab12cd@inbox.receiptsnap.app". */
export function tokenFromAddress(address) {
  if (!address) return null;
  const m = String(address)
    .toLowerCase()
    .match(/user-([a-z0-9]+)@/i);
  return m ? m[1] : null;
}

/**
 * Handle a normalized inbound email.
 * @param {{
 *   to: string, from?: string, subject?: string, text?: string,
 *   attachments?: Array<{ filename?: string, contentType?: string, contentBase64: string }>
 * }} email
 * @param {string} preferredDateFormat
 * @returns {Promise<{ token: string, ingested: number, ids: string[] }>}
 */
export async function handleInboundEmail(email, preferredDateFormat = 'MM/DD/YYYY') {
  const token = tokenFromAddress(email.to);
  if (!token) {
    const err = new Error('Could not derive forwarding token from recipient address');
    err.status = 422;
    throw err;
  }

  const ids = [];
  const attachments = email.attachments || [];
  const allSupported = attachments.filter(
    (a) => IMAGE_TYPES.includes(a.contentType) || a.contentType === 'application/pdf',
  );
  // Each attachment costs a Gemini call — cap per email and log what we skip.
  const supported = allSupported.slice(0, MAX_ATTACHMENTS_PER_EMAIL);
  if (allSupported.length > supported.length) {
    const skipped = allSupported.slice(MAX_ATTACHMENTS_PER_EMAIL);
    console.warn(
      `[inbound-email] skipping ${skipped.length} attachment(s) over the per-email cap of ${MAX_ATTACHMENTS_PER_EMAIL}: ` +
        skipped.map((a) => a.filename || a.contentType || 'unknown').join(', '),
    );
  }

  if (supported.length > 0) {
    // One pending entry per supported attachment (PDFs are sent to Gemini too).
    for (const att of supported) {
      // Inbound mail draws from the same service-wide daily Gemini budget.
      const budget = globalCheckAndConsume();
      if (!budget.ok) {
        if (ids.length > 0) {
          // Partial success: keep what we ingested, log the remainder.
          console.warn('[inbound-email] global daily Gemini cap hit mid-email; remaining attachments skipped');
          break;
        }
        const err = new Error(budget.message);
        err.status = budget.status;
        throw err;
      }
      const isImage = IMAGE_TYPES.includes(att.contentType);
      let extraction;
      try {
        extraction = await extractReceipt({
          ocrText: `${email.subject || ''}\n${email.text || ''}`.trim(),
          imageBase64: att.contentBase64,
          imageMimeType: att.contentType,
          preferredDateFormat,
        });
      } catch (err) {
        // The Gemini call failed — give the global daily slot back so a failure
        // doesn't permanently burn a billing-budget slot (mirrors /extract).
        if (!err.status || err.status >= 500) globalRefund();
        // Skip this attachment but keep processing the rest of the email.
        console.warn(`[inbound-email] extraction failed for attachment: ${err.message}`);
        continue;
      }
      ids.push(
        enqueue(token, {
          extraction,
          imageBase64: isImage ? att.contentBase64 : null,
          imageMimeType: isImage ? att.contentType : null,
          source: 'email',
        }),
      );
    }
  } else {
    // No attachment — parse the email body itself (digital/e-receipt).
    const budget = globalCheckAndConsume();
    if (!budget.ok) {
      const err = new Error(budget.message);
      err.status = budget.status;
      throw err;
    }
    let extraction;
    try {
      extraction = await extractReceipt({
        ocrText: `${email.subject || ''}\n${email.text || ''}`.trim(),
        preferredDateFormat,
      });
    } catch (err) {
      // Refund the global slot on a server-side Gemini failure (mirrors /extract)
      // so a failed body-only parse doesn't permanently burn a budget slot.
      if (!err.status || err.status >= 500) globalRefund();
      throw err;
    }
    ids.push(enqueue(token, { extraction, source: 'email' }));
  }

  return { token, ingested: ids.length, ids };
}

/** Constant-time string compare (hash both sides so lengths always match). */
function secretsEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Shared-secret gate so only your mail provider can post. Prefer the
 * X-Inbound-Secret header; the `?secret=` query param is kept ONLY because
 * SendGrid Inbound Parse can't send custom headers (query strings can leak
 * into logs — see the README). Requires the secret to be configured: when it
 * is unset, the /inbound-email route refuses in production (503) and only
 * stays open in dev.
 */
export function verifyInboundSecret(req) {
  if (!config.inboundEmailSecret) return !config.isProduction; // dev-only open
  const provided =
    req.headers['x-inbound-secret'] || req.query.secret || req.body?.secret;
  if (!provided) return false;
  return secretsEqual(provided, config.inboundEmailSecret);
}
