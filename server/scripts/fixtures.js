// Downloads a DIVERSE, categorized corpus of REAL images for the robustness
// gauntlet, and can vertically stitch several receipt photos into one long
// image (to exercise the "stitch one long receipt from several photos" path).
//
// Categories:
//   clean        — crisp printed receipts (happy path)
//   hard         — real-world thermal scans: faded, skewed, crumpled, partial
//                  (ICDAR-2019-SROIE — actual photographed/scanned store receipts)
//   nonReceipt   — NOT receipts at all (dog, face, segmentation image) — the
//                  competitor hallucinated a receipt from a keyboard photo; we
//                  must degrade gracefully instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Jimp from 'jimp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(__dirname, '../fixtures');

const sroie = (n) => `https://raw.githubusercontent.com/zzzDavid/ICDAR-2019-SROIE/master/data/img/${n}.jpg`;

export const CATEGORIES = {
  clean: [
    { name: 'clean_eastrepair.png', url: 'https://templates.invoicehome.com/receipt-template-us-neat-750px.png', mime: 'image/png' },
    { name: 'clean_sroie_000.jpg', url: sroie('000'), mime: 'image/jpeg' },
  ],
  hard: [
    { name: 'hard_sroie_001.jpg', url: sroie('001'), mime: 'image/jpeg' },
    { name: 'hard_sroie_002.jpg', url: sroie('002'), mime: 'image/jpeg' },
    { name: 'hard_sroie_003.jpg', url: sroie('003'), mime: 'image/jpeg' },
    { name: 'hard_sroie_005.jpg', url: sroie('005'), mime: 'image/jpeg' },
    { name: 'hard_sroie_020.jpg', url: sroie('020'), mime: 'image/jpeg' },
    { name: 'hard_sroie_050.jpg', url: sroie('050'), mime: 'image/jpeg' },
    { name: 'hard_sroie_100.jpg', url: sroie('100'), mime: 'image/jpeg' },
    { name: 'hard_sroie_150.jpg', url: sroie('150'), mime: 'image/jpeg' },
    { name: 'hard_sroie_200.jpg', url: sroie('200'), mime: 'image/jpeg' },
    { name: 'hard_sroie_300.jpg', url: sroie('300'), mime: 'image/jpeg' },
    { name: 'hard_sroie_400.jpg', url: sroie('400'), mime: 'image/jpeg' },
    { name: 'hard_sroie_500.jpg', url: sroie('500'), mime: 'image/jpeg' },
    { name: 'hard_sroie_600.jpg', url: sroie('600'), mime: 'image/jpeg' },
  ],
  nonReceipt: [
    { name: 'nonreceipt_dog.jpg', url: 'https://raw.githubusercontent.com/pytorch/hub/master/images/dog.jpg', mime: 'image/jpeg' },
    { name: 'nonreceipt_face.jpg', url: 'https://raw.githubusercontent.com/opencv/opencv/master/samples/data/lena.jpg', mime: 'image/jpeg' },
    { name: 'nonreceipt_scene.png', url: 'https://raw.githubusercontent.com/pytorch/hub/master/images/deeplab1.png', mime: 'image/png' },
  ],
  // Pages that get stitched into ONE long receipt (multi-photo capture path).
  stitchPages: [
    { name: 'stitch_p1.jpg', url: sroie('010'), mime: 'image/jpeg' },
    { name: 'stitch_p2.jpg', url: sroie('032'), mime: 'image/jpeg' },
  ],
};

async function fetchWithTimeout(url, ms = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

async function download(src) {
  const dest = path.join(FIXTURE_DIR, src.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return { ...src, path: dest, base64: fs.readFileSync(dest).toString('base64') };
  }
  const res = await fetchWithTimeout(src.url);
  if (!res.ok) {
    console.warn(`  ! skip ${src.name}: HTTP ${res.status}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`  ↓ ${src.name} (${(buf.length / 1024).toFixed(0)} KB)`);
  return { ...src, path: dest, base64: buf.toString('base64') };
}

/** Ensure all categories are present; returns { clean, hard, nonReceipt, stitchPages }. */
export async function ensureAll() {
  if (!fs.existsSync(FIXTURE_DIR)) fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const out = {};
  for (const [cat, sources] of Object.entries(CATEGORIES)) {
    out[cat] = [];
    for (const s of sources) {
      const f = await download(s);
      if (f) out[cat].push(f);
    }
  }
  return out;
}

/** Backward-compatible: the original 5-image basic set used by test-extract.js. */
export async function ensureFixtures() {
  const all = await ensureAll();
  return [...all.clean, ...all.hard.slice(0, 3)];
}

/**
 * Vertically stitch several receipt photos into ONE tall image (normalizing
 * widths), mirroring the app's stitchImages for a long receipt. Returns the
 * combined JPEG as base64 and also writes it to fixtures for inspection.
 */
export async function stitchToBase64(files) {
  const images = await Promise.all(files.map((f) => Jimp.read(f.path)));
  const targetW = Math.min(...images.map((im) => im.bitmap.width));
  const resized = images.map((im) => im.clone().resize(targetW, Jimp.AUTO));
  const totalH = resized.reduce((h, im) => h + im.bitmap.height, 0);
  const canvas = new Jimp(targetW, totalH, 0xffffffff);
  let y = 0;
  for (const im of resized) {
    canvas.composite(im, 0, y);
    y += im.bitmap.height;
  }
  const dest = path.join(FIXTURE_DIR, 'stitched_long_receipt.jpg');
  await canvas.writeAsync(dest);
  const buf = await canvas.getBufferAsync(Jimp.MIME_JPEG);
  return { name: 'stitched_long_receipt.jpg', path: dest, mime: 'image/jpeg', base64: buf.toString('base64'), width: targetW, height: totalH };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  ensureAll().then((a) => {
    const n = Object.values(a).reduce((s, v) => s + v.length, 0);
    console.log(`Ready: ${n} fixtures across ${Object.keys(a).length} categories in ${FIXTURE_DIR}`);
  });
}
