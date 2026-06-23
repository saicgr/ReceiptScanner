// ReceiptSnap proxy — thin Express server.
//
// Routes:
//   GET  /health                 liveness + config sanity
//   POST /device/register        mint a stateless device token (per-IP limited)
//   GET  /forwarding-address     mints/returns a user's unique inbox address
//   POST /extract                OCR text + image -> Gemini -> structured JSON
//   POST /detect-receipts        multi-receipt bounding boxes ("Refine with AI")
//   POST /inbound-email          mail-provider webhook (forwarding feature)
//   GET  /pending                app pulls email-ingested receipts
//   POST /pending/ack            app acknowledges, clearing them from the queue
//   GET  /roadmap                curated roadmap + live upvote counts + my votes
//   POST /roadmap/:id/vote       toggle my upvote on a roadmap item
//   POST /feature-requests       submit a private feature request (rate-limited)
//
// Auth: every endpoint that costs money or exposes user data requires a valid
// X-Device-Id + X-Device-Token pair (see deviceAuth.js). No CORS middleware —
// the only clients are native apps and the mail webhook, neither needs it.
//
// The server is stateless except in-memory rate counters and the short-lived
// pending queue. No user receipts are persisted server-side.
import express from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { config, assertConfigured } from './config.js';
import { extractReceipt, detectReceipts, summarizeReceipt } from './gemini.js';
import { deviceTokenFor, requireDeviceAuth } from './deviceAuth.js';
import {
  checkAndConsume,
  peek,
  refund,
  ipCheckAndConsume,
  globalCheckAndConsume,
  globalRefund,
  deviceActionCheckAndConsume,
} from './rateLimit.js';
import { handleInboundEmail, verifyInboundSecret } from './inboundEmail.js';
import { list as listPending, ack as ackPending } from './pendingStore.js';
import { ROADMAP_ITEMS, ROADMAP_BY_ID, UPDATED_AT as ROADMAP_UPDATED_AT } from './roadmapData.js';
import {
  hashDevice,
  getVoteCounts,
  getDeviceVotes,
  toggleVote,
  insertFeatureRequest,
} from './featureStore.js';

const app = express();
// Render terminates TLS at a proxy; trust one hop so req.ip is the client.
app.set('trust proxy', 1);

// Per-route body parsers — only the image-bearing routes get big limits.
const jsonSmall = express.json({ limit: '50kb' }); // register / ack
const jsonImage = express.json({ limit: '12mb' }); // extract / detect (one base64 image)
const jsonEmail = express.json({ limit: '30mb' }); // inbound-email JSON (attachments)

// multer handles multipart/form-data from mail providers like SendGrid Parse.
// Caps: 10 MB per file, max 5 files — every attachment is potential memory +
// a billed Gemini call (handleInboundEmail further caps processing at 3).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
});

/** The short email-routing token, derived from an AUTHENTICATED device id. */
function forwardingToken(deviceId) {
  return createHash('sha256').update(String(deviceId)).digest('hex').slice(0, 10);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'receiptsnap-proxy',
    model: config.gemini.model,
    geminiConfigured: Boolean(config.gemini.apiKey),
    time: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /device/register
// Body { deviceId } -> { deviceToken }. The token is a stateless HMAC the
// device must present (X-Device-Token) on every authed call. Registration is
// the abuse surface for minting fresh identities, so it is per-IP limited.
// ---------------------------------------------------------------------------
app.post('/device/register', jsonSmall, (req, res) => {
  const ipLimit = ipCheckAndConsume(
    req.ip,
    'register',
    config.rateLimit.registerPerDayPerIp,
  );
  if (!ipLimit.ok) {
    return res.status(ipLimit.status).json({ error: ipLimit.reason, message: ipLimit.message });
  }
  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
  if (!deviceId || deviceId.length > 128) {
    return res
      .status(400)
      .json({ error: 'bad_request', message: 'Provide a deviceId string (max 128 chars).' });
  }
  res.json({ deviceToken: deviceTokenFor(deviceId) });
});

// ---------------------------------------------------------------------------
// Forwarding address minting (authed — it routes the user's e-receipts).
// Deterministic from the authenticated device id.
// ---------------------------------------------------------------------------
app.get('/forwarding-address', requireDeviceAuth, (req, res) => {
  const token = forwardingToken(req.deviceId);
  res.json({
    token,
    address: `user-${token}@${config.forwardingDomain}`,
  });
});

// ---------------------------------------------------------------------------
// POST /extract
// Accepts JSON: { ocrText, imageBase64, imageMimeType, preferredDateFormat }
// Requires X-Device-Id + X-Device-Token. Validates BEFORE consuming quota and
// refunds the scan when Gemini fails with a 5xx/timeout.
// ---------------------------------------------------------------------------
app.post('/extract', jsonImage, requireDeviceAuth, async (req, res) => {
  // Validate the body first — a bad request must never burn a scan.
  const { ocrText, imageBase64, imageMimeType, preferredDateFormat, categoryHints } = req.body || {};
  if (!ocrText && !imageBase64) {
    return res
      .status(400)
      .json({ error: 'bad_request', message: 'Provide ocrText and/or imageBase64.' });
  }

  const ipLimit = ipCheckAndConsume(req.ip, 'extract', config.rateLimit.extractPerDayPerIp);
  if (!ipLimit.ok) {
    return res.status(ipLimit.status).json({ error: ipLimit.reason, message: ipLimit.message });
  }
  const limit = checkAndConsume(req.deviceId);
  if (!limit.ok) {
    return res.status(limit.status).json({
      error: limit.reason,
      message: limit.message || 'Rate limit',
    });
  }
  const budget = globalCheckAndConsume();
  if (!budget.ok) {
    refund(req.deviceId); // the device's scan wasn't actually spent
    return res.status(budget.status).json({ error: budget.reason, message: budget.message });
  }

  try {
    const result = await extractReceipt({
      ocrText,
      imageBase64,
      imageMimeType,
      preferredDateFormat,
      categoryHints: Array.isArray(categoryHints) ? categoryHints.slice(0, 40) : undefined,
    });
    res.json({
      ...result,
      _meta: {
        remainingToday: limit.remainingToday,
        lifetimeRemaining: limit.lifetimeRemaining,
        model: config.gemini.model,
      },
    });
  } catch (err) {
    console.error('[extract] error:', err.message);
    // Gemini 5xx or timeout (no status): the user got nothing — refund the scan.
    if (!err.status || err.status >= 500) {
      refund(req.deviceId);
      globalRefund();
    }
    res
      .status(err.status && err.status < 500 ? err.status : 502)
      .json({ error: 'extraction_failed', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /summarize
// Accepts JSON: { receipt: {...compact fields...} }. Requires device auth.
// Optional, opt-in one-line AI summary (TASK 19). It's a billed Gemini call but
// NOT a "scan" — it does not consume the device scan counter; only the per-IP
// and global daily caps apply (with a global refund on server-side failure).
// ---------------------------------------------------------------------------
app.post('/summarize', jsonSmall, requireDeviceAuth, async (req, res) => {
  const { receipt } = req.body || {};
  if (!receipt || typeof receipt !== 'object') {
    return res.status(400).json({ error: 'bad_request', message: 'Provide receipt.' });
  }

  const ipLimit = ipCheckAndConsume(req.ip, 'summarize', config.rateLimit.extractPerDayPerIp);
  if (!ipLimit.ok) {
    return res.status(ipLimit.status).json({ error: ipLimit.reason, message: ipLimit.message });
  }
  const budget = globalCheckAndConsume();
  if (!budget.ok) {
    return res.status(budget.status).json({ error: budget.reason, message: budget.message });
  }

  try {
    const summary = await summarizeReceipt(receipt);
    res.json({ summary });
  } catch (err) {
    console.error('[summarize] error:', err.message);
    if (!err.status || err.status >= 500) globalRefund();
    res
      .status(err.status && err.status < 500 ? err.status : 502)
      .json({ error: 'summarize_failed', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /detect-receipts
// Accepts JSON: { imageBase64, imageMimeType }. Requires device auth.
// OPTIONAL "Refine with AI" path — the app detects multiple receipts in one
// photo on-device for free; this is only called when the user asks for a more
// accurate split. Rate-limited like /extract since it's a billed Gemini call.
// ---------------------------------------------------------------------------
app.post('/detect-receipts', jsonImage, requireDeviceAuth, async (req, res) => {
  const { imageBase64, imageMimeType } = req.body || {};
  if (!imageBase64) {
    return res.status(400).json({ error: 'bad_request', message: 'Provide imageBase64.' });
  }

  // Shares the per-IP 'extract' bucket — it's the same class of billed call.
  const ipLimit = ipCheckAndConsume(req.ip, 'extract', config.rateLimit.extractPerDayPerIp);
  if (!ipLimit.ok) {
    return res.status(ipLimit.status).json({ error: ipLimit.reason, message: ipLimit.message });
  }
  const limit = checkAndConsume(req.deviceId);
  if (!limit.ok) {
    return res.status(limit.status).json({
      error: limit.reason,
      message: limit.message || 'Rate limit',
    });
  }
  const budget = globalCheckAndConsume();
  if (!budget.ok) {
    refund(req.deviceId);
    return res.status(budget.status).json({ error: budget.reason, message: budget.message });
  }

  try {
    const out = await detectReceipts({ imageBase64, imageMimeType });
    res.json({
      ...out,
      _meta: {
        remainingToday: limit.remainingToday,
        lifetimeRemaining: limit.lifetimeRemaining,
        model: config.gemini.model,
      },
    });
  } catch (err) {
    console.error('[detect-receipts] error:', err.message);
    if (!err.status || err.status >= 500) {
      refund(req.deviceId);
      globalRefund();
    }
    res
      .status(err.status && err.status < 500 ? err.status : 502)
      .json({ error: 'detection_failed', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /inbound-email
// Supports BOTH application/json (normalized) and multipart/form-data (SendGrid
// Inbound Parse style with file attachments + to/from/subject/text fields).
// Gated by INBOUND_EMAIL_SECRET: in production an unset secret DISABLES the
// route (503) rather than leaving a Gemini-billing endpoint open to the world.
// ---------------------------------------------------------------------------
app.post('/inbound-email', jsonEmail, upload.any(), async (req, res) => {
  if (config.isProduction && !config.inboundEmailSecret) {
    console.error('[inbound-email] refused: INBOUND_EMAIL_SECRET is not set in production');
    return res.status(503).json({
      error: 'inbound_email_disabled',
      message: 'Email forwarding is not configured on this server.',
    });
  }
  if (!verifyInboundSecret(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    let email;
    if (req.is('application/json')) {
      email = req.body; // { to, from, subject, text, attachments:[{contentType,contentBase64}] }
    } else {
      // multipart (SendGrid Parse): fields + uploaded files.
      const files = Array.isArray(req.files) ? req.files : [];
      email = {
        to: req.body.to || req.body.envelope ? extractTo(req.body) : '',
        from: req.body.from || '',
        subject: req.body.subject || '',
        text: req.body.text || req.body.email || '',
        attachments: files.map((f) => ({
          filename: f.originalname,
          contentType: f.mimetype,
          contentBase64: f.buffer.toString('base64'),
        })),
      };
    }
    const out = await handleInboundEmail(email, req.body.preferredDateFormat);
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[inbound-email] error:', err.message);
    res.status(err.status || 500).json({ error: 'inbound_failed', message: err.message });
  }
});

function extractTo(body) {
  if (body.to) return body.to;
  try {
    const env = typeof body.envelope === 'string' ? JSON.parse(body.envelope) : body.envelope;
    return Array.isArray(env?.to) ? env.to[0] : env?.to || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Pending queue (app pulls email-ingested receipts)
// Reads/acks authenticate via the DEVICE TOKEN; the short sha256(deviceId)
// token is derived server-side and remains only the email-routing key — it no
// longer grants read access on its own.
// ---------------------------------------------------------------------------
app.get('/pending', requireDeviceAuth, (req, res) => {
  const token = forwardingToken(req.deviceId);
  res.json({ token, items: listPending(token) });
});

app.post('/pending/ack', jsonSmall, requireDeviceAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) {
    return res.status(400).json({ error: 'bad_request', message: 'ids[] required' });
  }
  const removed = ackPending(forwardingToken(req.deviceId), ids);
  res.json({ ok: true, removed });
});

// ---------------------------------------------------------------------------
// Roadmap & feature requests (durable storage in Supabase; see featureStore.js)
//
//   GET  /roadmap              curated items + live upvote counts + my votes
//   POST /roadmap/:id/vote     toggle my upvote on a votable item
//   POST /feature-requests     submit a private feature request (rate-limited)
//
// All authed. Vote reads degrade gracefully (counts 0) when storage is down;
// writes return 503 so the app can show "voting is temporarily unavailable".
// ---------------------------------------------------------------------------
app.get('/roadmap', requireDeviceAuth, async (req, res) => {
  const deviceHash = hashDevice(req.deviceId);
  // Both reads degrade to empty on storage failure — the curated list still ships.
  const [counts, myVotes] = await Promise.all([getVoteCounts(), getDeviceVotes(deviceHash)]);
  const items = ROADMAP_ITEMS.map((it) => ({
    ...it,
    upvotes: counts[it.id] ?? 0,
    voted: myVotes.has(it.id),
  }));
  res.json({ updatedAt: ROADMAP_UPDATED_AT, items });
});

app.post('/roadmap/:id/vote', jsonSmall, requireDeviceAuth, async (req, res) => {
  const item = ROADMAP_BY_ID.get(req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'not_found', message: 'Unknown roadmap item.' });
  }
  if (item.status === 'shipped') {
    return res
      .status(400)
      .json({ error: 'bad_request', message: 'Shipped items cannot be voted on.' });
  }
  try {
    const { voted, count } = await toggleVote(item.id, hashDevice(req.deviceId));
    res.json({ id: item.id, voted, upvotes: count });
  } catch (err) {
    console.error('[roadmap vote] error:', err.message);
    const status = err.status || 500;
    res.status(status).json({
      error: err.code || 'vote_failed',
      message:
        status === 503
          ? 'Voting is temporarily unavailable. Please try again later.'
          : err.message,
    });
  }
});

app.post('/feature-requests', jsonSmall, requireDeviceAuth, async (req, res) => {
  // Validate BEFORE consuming the per-device daily bucket.
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description =
    typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const rawCategory = typeof req.body?.category === 'string' ? req.body.category.trim() : '';
  if (title.length < 1 || title.length > 120) {
    return res
      .status(400)
      .json({ error: 'bad_request', message: 'Provide a title (1–120 characters).' });
  }
  if (description.length > 2000) {
    return res
      .status(400)
      .json({ error: 'bad_request', message: 'Description must be 2000 characters or fewer.' });
  }
  const category = rawCategory ? rawCategory.slice(0, 60) : null;

  const limit = deviceActionCheckAndConsume(
    req.deviceId,
    'feature_request',
    config.rateLimit.featureRequestsPerDay,
  );
  if (!limit.ok) {
    return res.status(limit.status).json({ error: limit.reason, message: limit.message });
  }

  try {
    const { id } = await insertFeatureRequest({
      deviceHash: hashDevice(req.deviceId),
      title,
      description,
      category,
    });
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[feature-requests] error:', err.message);
    const status = err.status || 500;
    res.status(status).json({
      error: err.code || 'submit_failed',
      message:
        status === 503
          ? 'Feature requests are temporarily unavailable. Please try again later.'
          : err.message,
    });
  }
});

// ---------------------------------------------------------------------------
// Rate-limit status (no consume)
// ---------------------------------------------------------------------------
app.get('/limits', requireDeviceAuth, (req, res) => {
  res.json(peek(req.deviceId));
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const port = config.port;

// Only auto-listen when run directly (tests import the app without binding).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    assertConfigured();
  } catch (e) {
    console.warn(`[warn] ${e.message}`);
  }
  app.listen(port, () => {
    console.log(`ReceiptSnap proxy listening on :${port} (model ${config.gemini.model})`);
  });
}

export default app;
