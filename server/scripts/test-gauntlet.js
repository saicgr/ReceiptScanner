// Robustness gauntlet — runs the extraction pipeline against a DIVERSE corpus:
// clean receipts, hard real-world thermal scans (faded/skewed/crumpled/partial),
// a stitched multi-photo long receipt, and NON-receipts (graceful degradation).
//
// Exit non-zero only on real failures: a crash, an invalid contract, a leaked
// "not found" literal, or a non-receipt that was confidently hallucinated.
// The model being unsure about a genuinely hard scan is reported, not failed.
//
//   node scripts/test-gauntlet.js
import assert from 'node:assert';
import app from '../src/index.js';
import { config } from '../src/config.js';
import { ensureAll, stitchToBase64 } from './fixtures.js';
import { makeGroceryReceiptPdf } from './make-pdf.js';

let server, base;
const DEVICE = 'gauntlet-device';
const failures = [];

function hasNotFound(obj) {
  return JSON.stringify(obj).toLowerCase().includes('not found');
}

function validateContract(r, label) {
  assert.ok(typeof r.vendor === 'string', `${label}: vendor string`);
  assert.ok(r.date === null || /^\d{4}-\d{2}-\d{2}$/.test(r.date), `${label}: date ISO|null (${r.date})`);
  assert.ok(['high', 'medium', 'low'].includes(r.date_confidence), `${label}: date_confidence enum`);
  assert.strictEqual(typeof r.total, 'number', `${label}: total number`);
  assert.ok(r.tax === null || typeof r.tax === 'number', `${label}: tax number|null`);
  assert.ok(typeof r.currency === 'string' && r.currency.length === 3, `${label}: currency ISO (${r.currency})`);
  assert.ok(Array.isArray(r.line_items), `${label}: line_items array`);
  assert.ok(!hasNotFound(r), `${label}: NEVER contains the literal "not found"`);
}

let TOKEN = '';

/** Register the test device once so authed calls can present X-Device-Token. */
async function registerDevice() {
  const r = await fetch(`${base}/device/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: DEVICE }),
  }).then((x) => x.json());
  TOKEN = r.deviceToken;
}

async function extract(imageBase64, mime) {
  const res = await fetch(`${base}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': DEVICE, 'X-Device-Token': TOKEN },
    body: JSON.stringify({ imageBase64, imageMimeType: mime, preferredDateFormat: 'MM/DD/YYYY' }),
  });
  return { status: res.status, body: await res.json() };
}

function pad(s, n) { return String(s).slice(0, n).padEnd(n); }

async function main() {
  if (!config.gemini.apiKey) { console.error('No GEMINI_API_KEY'); process.exit(2); }
  await new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
  await registerDevice();
  console.log(`\nROBUSTNESS GAUNTLET — model ${config.gemini.model}\n${base}\n`);

  console.log('Fetching corpus…');
  const corpus = await ensureAll();
  console.log(`  clean=${corpus.clean.length} hard=${corpus.hard.length} nonReceipt=${corpus.nonReceipt.length} stitchPages=${corpus.stitchPages.length}`);

  // ---- REAL receipts: clean + hard ----
  console.log('\n=== REAL RECEIPTS (clean + hard real-world scans) ===');
  console.log(pad('image', 22), pad('vendor', 26), pad('date', 12), pad('total', 12), pad('cur', 4), 'items conf');
  const real = [...corpus.clean, ...corpus.hard];
  let meaningful = 0;
  for (const f of real) {
    try {
      const { status, body } = await extract(f.base64, f.mime);
      assert.strictEqual(status, 200, `${f.name}: HTTP ${status}`);
      validateContract(body, f.name);
      const ok = !!body.vendor && body.total > 0;
      if (ok) meaningful++;
      console.log(
        pad(f.name, 22),
        pad(body.vendor || '—', 26),
        pad(body.date || '—', 12),
        pad(body.total, 12),
        pad(body.currency, 4),
        `${String(body.line_items.length).padStart(2)}  ${body.date_confidence}${ok ? '' : '  ⚠ sparse'}`,
      );
    } catch (e) {
      failures.push(e.message);
      console.log(pad(f.name, 22), `✗ ${e.message}`);
    }
  }
  const realRate = Math.round((meaningful / real.length) * 100);
  console.log(`\n  meaningful extraction (vendor + total>0): ${meaningful}/${real.length} (${realRate}%)`);
  // The pipeline must never crash / break contract on hard scans; we expect a
  // strong majority to yield usable data.
  assert.ok(realRate >= 70, `real-receipt success rate too low: ${realRate}% (<70%)`);

  // ---- STITCHED long receipt (multi-photo capture) ----
  console.log('\n=== STITCHED LONG RECEIPT (multiple photos → one) ===');
  try {
    const stitched = await stitchToBase64(corpus.stitchPages);
    console.log(`  combined ${corpus.stitchPages.length} pages → ${stitched.width}×${stitched.height}px`);
    const { status, body } = await extract(stitched.base64, 'image/jpeg');
    assert.strictEqual(status, 200, 'stitched: HTTP');
    validateContract(body, 'stitched');
    console.log(`  → vendor="${body.vendor}" total=${body.total} ${body.currency} items=${body.line_items.length} conf=${body.date_confidence}`);
    assert.ok(body.vendor || body.line_items.length > 0 || body.total > 0, 'stitched produced nothing usable');
  } catch (e) {
    failures.push(e.message);
    console.log(`  ✗ ${e.message}`);
  }

  // ---- MULTI-PAGE PDF (grocery e-receipt split across pages) ----
  console.log('\n=== MULTI-PAGE PDF (grocery receipt across 2 pages) ===');
  try {
    const pdfB64 = makeGroceryReceiptPdf().toString('base64');
    const { status, body } = await extract(pdfB64, 'application/pdf');
    assert.strictEqual(status, 200, 'pdf: HTTP');
    validateContract(body, 'pdf');
    console.log(`  → vendor="${body.vendor}" date=${body.date} total=${body.total} ${body.currency} items=${body.line_items.length}`);
    // Must read BOTH pages: items from page 1 + page 2, EUR, total 25.28.
    assert.ok(body.line_items.length >= 6, `pdf: expected >=6 items across pages, got ${body.line_items.length}`);
    assert.strictEqual(body.currency, 'EUR', `pdf: currency ${body.currency}`);
    assert.ok(Math.abs(body.total - 25.28) < 0.01, `pdf: total ${body.total} != 25.28`);
    console.log('  ✓ read across both pages, EUR 25.28, items merged');
  } catch (e) {
    failures.push(e.message);
    console.log(`  ✗ ${e.message}`);
  }

  // ---- NON-RECEIPTS: graceful degradation (the competitor's failure mode) ----
  console.log('\n=== NON-RECEIPTS (must degrade gracefully — no hallucinated receipt) ===');
  for (const f of corpus.nonReceipt) {
    try {
      const { status, body } = await extract(f.base64, f.mime);
      assert.strictEqual(status, 200, `${f.name}: HTTP ${status}`);
      validateContract(body, f.name);
      // Safety signal: the app must be able to tell the user "this looks empty".
      const safe =
        body.date_confidence === 'low' ||
        (body.field_confidence && body.field_confidence.total === 'low') ||
        body.total === 0 ||
        body.line_items.length === 0 ||
        body.vendor === '';
      console.log(
        `  ${pad(f.name, 22)} vendor="${body.vendor || '—'}" total=${body.total} ${body.currency} items=${body.line_items.length} conf=${body.date_confidence} ${safe ? '✓ safe' : '✗ HALLUCINATED'}`,
      );
      assert.ok(safe, `${f.name}: confidently hallucinated a receipt from a non-receipt`);
    } catch (e) {
      failures.push(e.message);
      console.log(`  ✗ ${f.name}: ${e.message}`);
    }
  }

  console.log(`\n${'='.repeat(56)}`);
  if (failures.length) {
    console.log(`GAUNTLET: ${failures.length} FAILURE(S)`);
    failures.forEach((f) => console.log('  - ' + f));
  } else {
    console.log('GAUNTLET: ALL CHECKS PASSED ✅');
  }
  console.log('='.repeat(56));
  server.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); if (server) server.close(); process.exit(1); });
