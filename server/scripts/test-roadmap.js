// Route tests for the Roadmap & Feature-Request endpoints. No Gemini needed.
//
// Boots the Express app on an ephemeral port and exercises /roadmap,
// /roadmap/:id/vote and /feature-requests. Adapts to whether durable storage
// (Supabase) is configured: with env set it asserts the live insert/vote path;
// without it, it asserts the graceful-degrade path (curated items at zero votes,
// writes -> 503). Prints a PASS/FAIL summary and exits non-zero on failure.
//
// Run from server/:  node scripts/test-roadmap.js
import assert from 'node:assert';
import app from '../src/index.js';
import { config } from '../src/config.js';
import { isConfigured } from '../src/featureStore.js';
import { ROADMAP_ITEMS } from '../src/roadmapData.js';

let server;
let base;
const results = [];

function ok(name) { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
function fail(name, err) { results.push({ name, ok: false, err }); console.log(`  ✗ ${name}\n      ${err}`); }
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { fail(name, e.message); } }

const DEVICE = 'roadmap-test-device-001';
let TOKEN = '';
const authHeaders = () => ({ 'X-Device-Id': DEVICE, 'X-Device-Token': TOKEN });

async function register(deviceId) {
  const r = await fetch(`${base}/device/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  }).then((x) => x.json());
  return r.deviceToken;
}

async function main() {
  const stored = isConfigured();
  console.log(`\nReceiptSnap roadmap route tests`);
  console.log(`Supabase storage configured: ${stored}\n`);

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  console.log(`server up at ${base}`);

  TOKEN = await register(DEVICE);
  assert.match(TOKEN, /^[a-f0-9]{64}$/, 'registration minted a token');

  const plannedItem = ROADMAP_ITEMS.find((i) => i.status !== 'shipped');
  const shippedItem = ROADMAP_ITEMS.find((i) => i.status === 'shipped');

  // --- GET /roadmap ---------------------------------------------------------
  console.log('\n[GET /roadmap]');
  await test('returns curated items with vote fields + updatedAt', async () => {
    const res = await fetch(`${base}/roadmap`, { headers: authHeaders() });
    assert.strictEqual(res.status, 200, `HTTP ${res.status}`);
    const j = await res.json();
    assert.ok(typeof j.updatedAt === 'string' && j.updatedAt, 'updatedAt present');
    assert.ok(Array.isArray(j.items) && j.items.length === ROADMAP_ITEMS.length, 'all items returned');
    for (const it of j.items) {
      assert.ok(it.id && it.title, 'item has id + title');
      assert.ok(['in_progress', 'planned', 'shipped'].includes(it.status), `valid status (${it.status})`);
      assert.strictEqual(typeof it.upvotes, 'number', 'upvotes is number');
      assert.strictEqual(typeof it.voted, 'boolean', 'voted is boolean');
    }
    console.log(`        → ${j.items.length} items, updatedAt=${j.updatedAt}`);
  });

  await test('without device token -> 401', async () => {
    const res = await fetch(`${base}/roadmap`);
    assert.strictEqual(res.status, 401, `HTTP ${res.status}`);
  });

  // --- POST /roadmap/:id/vote ----------------------------------------------
  console.log('\n[POST /roadmap/:id/vote]');
  await test('unknown id -> 404', async () => {
    const res = await fetch(`${base}/roadmap/not-a-real-id/vote`, { method: 'POST', headers: authHeaders() });
    assert.strictEqual(res.status, 404, `HTTP ${res.status}`);
  });

  await test('shipped item -> 400 (not votable)', async () => {
    const res = await fetch(`${base}/roadmap/${shippedItem.id}/vote`, { method: 'POST', headers: authHeaders() });
    assert.strictEqual(res.status, 400, `HTTP ${res.status}`);
  });

  if (stored) {
    await test('toggling a planned item twice flips voted and reconciles count', async () => {
      const first = await fetch(`${base}/roadmap/${plannedItem.id}/vote`, { method: 'POST', headers: authHeaders() }).then((x) => x.json());
      assert.strictEqual(first.voted, true, 'first toggle => voted');
      assert.ok(first.upvotes >= 1, 'count >= 1 after vote');
      const second = await fetch(`${base}/roadmap/${plannedItem.id}/vote`, { method: 'POST', headers: authHeaders() }).then((x) => x.json());
      assert.strictEqual(second.voted, false, 'second toggle => unvoted');
      assert.strictEqual(second.upvotes, first.upvotes - 1, 'count decremented');
    });

    await test('GET /roadmap reflects my vote after toggling on', async () => {
      await fetch(`${base}/roadmap/${plannedItem.id}/vote`, { method: 'POST', headers: authHeaders() });
      const j = await fetch(`${base}/roadmap`, { headers: authHeaders() }).then((x) => x.json());
      const mine = j.items.find((i) => i.id === plannedItem.id);
      assert.strictEqual(mine.voted, true, 'voted=true for me');
      assert.ok(mine.upvotes >= 1, 'upvotes >= 1');
      // Clean up so reruns start fresh.
      await fetch(`${base}/roadmap/${plannedItem.id}/vote`, { method: 'POST', headers: authHeaders() });
    });
  } else {
    await test('voting a planned item -> 503 when storage unconfigured', async () => {
      const res = await fetch(`${base}/roadmap/${plannedItem.id}/vote`, { method: 'POST', headers: authHeaders() });
      assert.strictEqual(res.status, 503, `HTTP ${res.status}`);
    });
  }

  // --- POST /feature-requests ----------------------------------------------
  console.log('\n[POST /feature-requests]');
  const postFR = (body, headers = authHeaders()) =>
    fetch(`${base}/feature-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  await test('empty title -> 400', async () => {
    const res = await postFR({ title: '   ', description: 'x' });
    assert.strictEqual(res.status, 400, `HTTP ${res.status}`);
  });

  await test('over-long title -> 400', async () => {
    const res = await postFR({ title: 'x'.repeat(121) });
    assert.strictEqual(res.status, 400, `HTTP ${res.status}`);
  });

  await test('over-long description -> 400', async () => {
    const res = await postFR({ title: 'Valid title', description: 'y'.repeat(2001) });
    assert.strictEqual(res.status, 400, `HTTP ${res.status}`);
  });

  if (stored) {
    await test('valid request -> 200 { ok, id }', async () => {
      const res = await postFR({ title: 'Add FreshBooks export', description: 'Itemized CSV', category: 'Export' });
      assert.strictEqual(res.status, 200, `HTTP ${res.status}`);
      const j = await res.json();
      assert.strictEqual(j.ok, true, 'ok=true');
      assert.ok(j.id, 'returns an id');
    });
  } else {
    await test('valid request -> 503 when storage unconfigured', async () => {
      const res = await postFR({ title: 'Add FreshBooks export', description: 'Itemized CSV' });
      assert.strictEqual(res.status, 503, `HTTP ${res.status}`);
    });
  }

  await test('per-device daily cap eventually returns 429', async () => {
    // Use a fresh device so we have the full bucket. Each call consumes the
    // bucket BEFORE the insert, so this holds whether or not storage is up.
    const capDevice = 'roadmap-cap-device';
    const capToken = await register(capDevice);
    const headers = { 'X-Device-Id': capDevice, 'X-Device-Token': capToken };
    const cap = config.rateLimit.featureRequestsPerDay;
    let saw429 = false;
    for (let i = 0; i < cap + 2; i++) {
      const res = await postFR({ title: `Spam ${i}` }, headers);
      if (res.status === 429) { saw429 = true; break; }
    }
    assert.ok(saw429, `expected a 429 within ${cap + 2} calls`);
  });

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
