// Generates placeholder brand assets (solid brand-green with a white receipt
// glyph) as valid PNGs, with no external dependencies (Node zlib only).
// Replace with real artwork before shipping. Run: node scripts/generate-assets.js
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const BRAND = [14, 124, 102]; // #0E7C66
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Draw: brand background; a centered white rounded rectangle ("receipt") with a
// zig-zag bottom and a few green lines, scaled to the canvas.
function render(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const cx = size / 2;
  const rw = size * 0.42; // receipt width
  const rh = size * 0.52; // receipt height
  const left = cx - rw / 2;
  const right = cx + rw / 2;
  const top = size * 0.22;
  const bottom = top + rh;
  const lineColor = BRAND;

  for (let y = 0; y < size; y++) {
    let off = y * (size * 3 + 1);
    raw[off++] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      let col = BRAND;
      const insideX = x >= left && x <= right;
      // zig-zag bottom edge
      const teeth = 10;
      const toothW = rw / teeth;
      const phase = ((x - left) % toothW) / toothW;
      const zig = bottom - Math.abs(phase - 0.5) * 2 * (size * 0.03);
      const insideY = y >= top && y <= zig;
      if (insideX && insideY) {
        col = WHITE;
        // green "text" lines
        const relY = (y - top) / rh;
        const isLine =
          (relY > 0.18 && relY < 0.23) ||
          (relY > 0.33 && relY < 0.38) ||
          (relY > 0.48 && relY < 0.53) ||
          (relY > 0.63 && relY < 0.68);
        const inMargin = x > left + rw * 0.12 && x < right - rw * 0.12;
        if (isLine && inMargin) col = lineColor;
        // a "total" bar
        if (relY > 0.78 && relY < 0.86 && x > left + rw * 0.12 && x < cx) col = lineColor;
      }
      raw[off++] = col[0];
      raw[off++] = col[1];
      raw[off++] = col[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

function solid(size, color) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    let off = y * (size * 3 + 1);
    raw[off++] = 0;
    for (let x = 0; x < size; x++) {
      raw[off++] = color[0];
      raw[off++] = color[1];
      raw[off++] = color[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.resolve(__dirname, '../assets');
fs.mkdirSync(dir, { recursive: true });

const outputs = {
  'icon.png': render(1024),
  'adaptive-icon.png': render(1024),
  'splash.png': render(1024),
  'notification-icon.png': render(96),
  'favicon.png': render(48),
};
for (const [name, buf] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(dir, name), buf);
  console.log(`wrote assets/${name} (${(buf.length / 1024).toFixed(1)} KB)`);
}
