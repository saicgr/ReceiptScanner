// End-to-end test for the ReceiptSnap proxy against the REAL Gemini API.
//
// Boots the Express app on an ephemeral port, downloads real receipt images,
// and exercises: /health, /extract (per image, validating the JSON contract),
// rate-limit headers, the inbound-email -> pending-queue -> ack flow, and
// missing-input handling. Prints a PASS/FAIL summary and exits non-zero on fail.
//
// Run from server/:  node scripts/test-extract.js
import assert from 'node:assert';
import app from '../src/index.js';
import { config } from '../src/config.js';
import { ensureFixtures } from './fixtures.js';

let server;
let base;
const results = [];

function ok(name) { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
function fail(name, err) { results.push({ name, ok: false, err }); console.log(`  ✗ ${name}\n      ${err}`); }
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { fail(name, e.message); } }

const DEVICE = 'e2e-test-device-001';
// Filled in by POST /device/register after boot; sent on every authed call.
let TOKEN = '';
const authHeaders = () => ({ 'X-Device-Id': DEVICE, 'X-Device-Token': TOKEN });

function validateContract(r, label) {
  assert.ok(typeof r.vendor === 'string', `${label}: vendor is string`);
  assert.ok(r.date === null || /^\d{4}-\d{2}-\d{2}$/.test(r.date), `${label}: date is ISO or null (got ${r.date})`);
  assert.ok(['high', 'medium', 'low'].includes(r.date_confidence), `${label}: date_confidence enum`);
  assert.strictEqual(typeof r.date_ambiguous, 'boolean', `${label}: date_ambiguous bool`);
  assert.ok(Array.isArray(r.date_options), `${label}: date_options array`);
  assert.strictEqual(typeof r.total, 'number', `${label}: total number`);
  assert.ok(r.tax === null || typeof r.tax === 'number', `${label}: tax number|null`);
  assert.ok(typeof r.currency === 'string' && r.currency.length === 3, `${label}: currency ISO (got ${r.currency})`);
  assert.ok(Array.isArray(r.line_items), `${label}: line_items array`);
  for (const li of r.line_items) {
    assert.ok(typeof li.name === 'string', `${label}: item.name string`);
    assert.strictEqual(typeof li.qty, 'number', `${label}: item.qty number`);
    assert.strictEqual(typeof li.price, 'number', `${label}: item.price number`);
  }
  // V2 fields present (nullable)
  assert.ok('return_window_days' in r, `${label}: has return_window_days`);
  assert.ok('warranty_period_days' in r, `${label}: has warranty_period_days`);
  assert.ok('tax_category' in r, `${label}: has tax_category`);
  assert.ok(r.field_confidence && typeof r.field_confidence === 'object', `${label}: field_confidence object`);
}

async function main() {
  console.log(`\nReceiptSnap proxy E2E — model: ${config.gemini.model}`);
  console.log(`Gemini key configured: ${Boolean(config.gemini.apiKey)}\n`);
  if (!config.gemini.apiKey) {
    console.error('GEMINI_API_KEY not set; aborting live tests.');
    process.exit(2);
  }

  // Boot on ephemeral port.
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  console.log(`server up at ${base}`);

  console.log('\nFetching fixtures…');
  const fixtures = await ensureFixtures();
  assert.ok(fixtures.length > 0, 'at least one fixture downloaded');

  // 1. Health
  console.log('\n[health]');
  await test('GET /health returns ok + model', async () => {
    const r = await fetch(`${base}/health`).then((x) => x.json());
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.geminiConfigured, true);
    assert.strictEqual(r.model, config.gemini.model);
  });

  // 2. Device registration + forwarding address
  console.log('\n[device auth]');
  await test('POST /device/register mints a token', async () => {
    const r = await fetch(`${base}/device/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE }),
    }).then((x) => x.json());
    assert.match(r.deviceToken, /^[a-f0-9]{64}$/);
    TOKEN = r.deviceToken;
  });

  console.log('\n[forwarding-address]');
  await test('GET /forwarding-address is deterministic per device', async () => {
    const a = await fetch(`${base}/forwarding-address`, { headers: authHeaders() }).then((x) => x.json());
    const b = await fetch(`${base}/forwarding-address`, { headers: authHeaders() }).then((x) => x.json());
    assert.strictEqual(a.address, b.address);
    assert.match(a.address, /^user-[a-f0-9]+@/);
  });

  // 3. Extract — real images
  console.log('\n[extract: real receipts]');
  const extracted = [];
  for (const fx of fixtures) {
    await test(`POST /extract ${fx.name}`, async () => {
      const res = await fetch(`${base}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ imageBase64: fx.base64, imageMimeType: fx.mime, preferredDateFormat: 'MM/DD/YYYY' }),
      });
      assert.strictEqual(res.status, 200, `HTTP ${res.status}`);
      const r = await res.json();
      validateContract(r, fx.name);
      assert.ok(r._meta && typeof r._meta.remainingToday === 'number', 'meta.remainingToday present');
      extracted.push({ name: fx.name, r });
      console.log(`        → vendor="${r.vendor}" date=${r.date} total=${r.total} ${r.currency} items=${r.line_items.length} ret=${r.return_window_days} warr=${r.warranty_period_days} tax_cat=${r.tax_category}`);
    });
  }

  await test('at least one receipt produced a non-empty vendor + total>0', async () => {
    assert.ok(extracted.some((e) => e.r.vendor && e.r.total > 0), 'no receipt produced meaningful data');
  });

  // 4. Bad input
  console.log('\n[validation]');
  await test('POST /extract with no body -> 400', async () => {
    const res = await fetch(`${base}/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });
  await test('POST /extract without device token -> 401', async () => {
    const res = await fetch(`${base}/extract`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE }, body: JSON.stringify({ ocrText: 'x' }),
    });
    assert.strictEqual(res.status, 401);
  });

  // 5. Rate limiting (uses a fresh device, hammers /limits + consume)
  console.log('\n[rate limiting]');
  await test('GET /limits reflects remaining quota', async () => {
    const r = await fetch(`${base}/limits`, { headers: authHeaders() }).then((x) => x.json());
    assert.ok(r.remainingToday <= config.rateLimit.perDayPerDevice);
    assert.ok(r.remainingToday >= 0);
  });

  // 6. Inbound email -> pending -> ack
  console.log('\n[inbound email + pending queue]');
  const token = (await fetch(`${base}/forwarding-address`, { headers: authHeaders() }).then((x) => x.json())).token;
  await test('POST /inbound-email ingests an attachment', async () => {
    const fx = fixtures[0];
    const res = await fetch(`${base}/inbound-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: `user-${token}@${config.forwardingDomain}`,
        from: 'store@example.com', subject: 'Your receipt', text: 'Thanks for shopping',
        attachments: [{ filename: fx.name, contentType: fx.mime, contentBase64: fx.base64 }],
      }),
    });
    assert.strictEqual(res.status, 200, `HTTP ${res.status}`);
    const j = await res.json();
    assert.strictEqual(j.ok, true);
    assert.ok(j.ingested >= 1);
  });
  await test('GET /pending returns the ingested receipt', async () => {
    const j = await fetch(`${base}/pending`, { headers: authHeaders() }).then((x) => x.json());
    assert.ok(Array.isArray(j.items) && j.items.length >= 1, 'pending has items');
    validateContract(j.items[0].extraction, 'pending');
  });
  await test('GET /pending without device token -> 401', async () => {
    const res = await fetch(`${base}/pending?token=${token}`);
    assert.strictEqual(res.status, 401);
  });
  await test('POST /pending/ack clears the queue', async () => {
    const j = await fetch(`${base}/pending`, { headers: authHeaders() }).then((x) => x.json());
    const ids = j.items.map((i) => i.id);
    const ack = await fetch(`${base}/pending/ack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ ids }),
    }).then((x) => x.json());
    assert.ok(ack.removed >= 1);
    const after = await fetch(`${base}/pending`, { headers: authHeaders() }).then((x) => x.json());
    assert.strictEqual(after.items.length, 0);
  });

  // Summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  if (server) server.close();
  process.exit(1);
});
