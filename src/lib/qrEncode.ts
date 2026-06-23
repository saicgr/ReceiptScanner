/**
 * qrEncode — a small, dependency-free QR Code encoder (byte mode).
 *
 * We have react-native-svg installed but no QR *generator* dependency, and the
 * task asks to keep deps minimal, so this is a pure-JS encoder that produces a
 * boolean module matrix which `<QrCode>` renders to SVG. It is intentionally
 * narrow: byte (8-bit) mode only, automatic version selection (1..40) and an
 * automatic mask. That is everything the receipt-sharing feature needs (we only
 * encode short JSON or a https URL), and being a pure function it is fully
 * unit-testable with no native bridge.
 *
 * The algorithm follows the QR Code 2005 spec (ISO/IEC 18004): Reed-Solomon ECC
 * over GF(256), the standard block interleaving, the 8 data masks scored by the
 * four penalty rules, and the BCH-encoded format/version information.
 *
 * Capacity reference (byte mode): version 40 at EC level L holds 2953 bytes —
 * the hard cap callers must respect. `encodeQr` throws `QrTooLargeError` when the
 * data does not fit so a caller can fall back to a file export rather than draw
 * a broken/truncated code.
 */

/** Error-correction level. We use the four standard levels. */
export type QrEcLevel = 'L' | 'M' | 'Q' | 'H';

/** Thrown when the payload exceeds the largest QR version's byte capacity. */
export class QrTooLargeError extends Error {
  constructor(byteLength: number, capacity: number) {
    super(`QR payload of ${byteLength} bytes exceeds capacity ${capacity}`);
    this.name = 'QrTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// GF(256) arithmetic for Reed-Solomon (primitive polynomial 0x11D).
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGalois() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/**
 * Build the Reed-Solomon generator polynomial of the given degree, returned as
 * `degree` coefficients in DESCENDING power order, EXCLUDING the leading x^degree
 * term (whose coefficient is always 1). This is the form the synthetic-division
 * `rsEncode` below consumes. For degree 7 the alpha-exponents are
 * 0,87,229,146,149,238,102,21 — i.e. coefficients[k] = α^expK.
 */
function rsGeneratorPoly(degree: number): number[] {
  // poly holds coefficients high→low including the leading 1; multiply by
  // (x - α^i) for i = 0..degree-1.
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      // (poly * x): shift up one degree.
      next[j] ^= poly[j];
      // (poly * α^i): scale in place.
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  // poly is [1, g_{d-1}, ..., g_0] (high→low); drop the leading 1.
  return poly.slice(1);
}

/** Compute the `ecLen` Reed-Solomon error-correction codewords for `data`. */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGeneratorPoly(ecLen); // length ecLen, high→low, no leading term
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        res[j] ^= gfMul(gen[j], factor);
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Capacity / EC tables (per version 1..40, per EC level).
// ---------------------------------------------------------------------------

/** Total number of data codewords (after ECC) for each version+level. */
// prettier-ignore
const DATA_CODEWORDS: Record<QrEcLevel, number[]> = {
  L: [19,34,55,80,108,136,156,194,232,274,324,370,428,461,523,589,647,721,795,861,932,1006,1094,1174,1276,1370,1468,1531,1631,1735,1843,1955,2071,2191,2306,2434,2566,2702,2812,2956],
  M: [16,28,44,64,86,108,124,154,182,216,254,290,334,365,415,453,507,563,627,669,714,782,860,914,1000,1062,1128,1193,1267,1373,1455,1541,1631,1725,1812,1914,1992,2102,2216,2334],
  Q: [13,22,34,48,62,76,88,110,132,154,180,206,244,261,295,325,367,397,445,485,512,568,614,664,718,754,808,871,911,985,1033,1115,1171,1231,1286,1354,1426,1502,1582,1666],
  H: [9,16,26,36,46,60,66,86,100,122,140,158,180,197,223,253,283,313,341,385,406,442,464,514,538,596,628,661,701,745,793,845,901,961,986,1054,1096,1142,1222,1276],
};

/** EC codewords per block, then [blocks in group1, blocks in group2]. */
// prettier-ignore
const EC_BLOCKS: Record<QrEcLevel, [ecPerBlock: number, g1: number, g1Words: number, g2: number, g2Words: number][]> = {
  L: [[7,1,19,0,0],[10,1,34,0,0],[15,1,55,0,0],[20,1,80,0,0],[26,1,108,0,0],[18,2,68,0,0],[20,2,78,0,0],[24,2,97,0,0],[30,2,116,0,0],[18,2,68,2,69],[20,4,81,0,0],[24,2,92,2,93],[26,4,107,0,0],[30,3,115,1,116],[22,5,87,1,88],[24,5,98,1,99],[28,1,107,5,108],[30,5,120,1,121],[28,3,113,4,114],[28,3,107,5,108],[28,4,116,4,117],[28,2,111,7,112],[30,4,121,5,122],[30,6,117,4,118],[26,8,106,4,107],[28,10,114,2,115],[30,8,122,4,123],[30,3,117,10,118],[30,7,116,7,117],[30,5,115,10,116],[30,13,115,3,116],[30,17,115,0,0],[30,17,115,1,116],[30,13,115,6,116],[30,12,121,7,122],[30,6,121,14,122],[30,17,122,4,123],[30,4,122,18,123],[30,20,117,4,118],[30,19,118,6,119]],
  M: [[10,1,16,0,0],[16,1,28,0,0],[26,1,44,0,0],[18,2,32,0,0],[24,2,43,0,0],[16,4,27,0,0],[18,4,31,0,0],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44],[30,1,50,4,51],[22,6,36,2,37],[22,8,37,1,38],[24,4,40,5,41],[24,5,41,5,42],[28,7,45,3,46],[28,10,46,1,47],[26,9,43,4,44],[26,3,44,11,45],[26,3,41,13,42],[26,17,42,0,0],[28,17,46,0,0],[28,4,47,14,48],[28,6,45,14,46],[28,8,47,13,48],[28,19,46,4,47],[28,22,45,3,46],[28,3,45,23,46],[28,21,45,7,46],[28,19,47,10,48],[28,2,46,29,47],[28,10,46,23,47],[28,14,46,21,47],[28,14,46,23,47],[28,12,47,26,48],[28,6,47,34,48],[28,29,46,14,47],[28,13,46,32,47],[28,40,47,7,48],[28,18,47,31,48]],
  Q: [[13,1,13,0,0],[22,1,22,0,0],[18,2,17,0,0],[26,2,24,0,0],[18,2,15,2,16],[24,4,19,0,0],[18,2,14,4,15],[22,4,18,2,19],[20,4,16,4,17],[24,6,19,2,20],[28,4,22,4,23],[26,4,20,6,21],[24,8,20,4,21],[20,11,16,5,17],[30,5,24,7,25],[24,15,19,2,20],[28,1,22,15,23],[28,17,22,1,23],[26,17,21,4,22],[30,15,24,5,25],[28,17,22,6,23],[30,7,24,16,25],[30,11,24,14,25],[30,11,24,16,25],[30,7,24,22,25],[28,28,22,6,23],[30,8,23,26,24],[30,4,24,31,25],[30,1,23,37,24],[30,15,24,25,25],[30,42,24,1,25],[30,10,24,35,25],[30,29,24,19,25],[30,44,24,7,25],[30,39,24,14,25],[30,46,24,10,25],[30,49,24,10,25],[30,48,24,14,25],[30,43,24,22,25],[30,34,24,34,25]],
  H: [[17,1,9,0,0],[28,1,16,0,0],[22,2,13,0,0],[16,4,9,0,0],[22,2,11,2,12],[28,4,15,0,0],[26,4,13,1,14],[26,4,14,2,15],[24,4,12,4,13],[28,6,15,2,16],[24,3,12,8,13],[28,7,14,4,15],[22,12,11,4,12],[24,11,12,5,13],[24,11,12,7,13],[30,3,15,13,16],[28,2,14,17,15],[28,2,14,19,15],[26,9,13,16,14],[28,15,15,10,16],[30,19,16,6,17],[24,34,13,0,0],[30,16,15,14,16],[30,30,16,2,17],[30,22,15,13,16],[30,33,16,4,17],[30,12,15,28,16],[30,11,15,31,16],[30,19,15,26,16],[30,23,15,25,16],[30,23,15,28,16],[30,19,15,35,16],[30,11,15,46,16],[30,59,16,1,17],[30,22,15,41,16],[30,2,15,64,16],[30,24,15,46,16],[30,42,15,32,16],[30,10,15,67,16],[30,20,15,61,16]],
};

/** Module count of the version's square matrix. */
function sizeForVersion(version: number): number {
  return version * 4 + 17;
}

/** Byte-mode character-count indicator bit length for a version. */
function byteCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

// ---------------------------------------------------------------------------
// Bit buffer.
// ---------------------------------------------------------------------------

class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

// ---------------------------------------------------------------------------
// UTF-8 encoding (RN has TextEncoder, but keep a tiny fallback for safety).
// ---------------------------------------------------------------------------

/** Encode a string to UTF-8 bytes. */
export function utf8Bytes(s: string): number[] {
  const te = (globalThis as { TextEncoder?: typeof TextEncoder }).TextEncoder;
  if (typeof te === 'function') return Array.from(new te().encode(s));
  // Minimal manual UTF-8 fallback.
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Version selection.
// ---------------------------------------------------------------------------

/** Byte-mode capacity (data bytes) for a version+level. */
function byteCapacity(version: number, ec: QrEcLevel): number {
  const totalDataBits = DATA_CODEWORDS[ec][version - 1] * 8;
  const overhead = 4 + byteCountBits(version); // mode + char-count indicators
  return Math.floor((totalDataBits - overhead) / 8);
}

/** Smallest version (1..40) that fits `byteLen`, or 0 when none does. */
function pickVersion(byteLen: number, ec: QrEcLevel): number {
  for (let v = 1; v <= 40; v++) {
    if (byteCapacity(v, ec) >= byteLen) return v;
  }
  return 0;
}

/** Largest byte-mode capacity across all versions at the given level. */
export function maxByteCapacity(ec: QrEcLevel = 'L'): number {
  return byteCapacity(40, ec);
}

// ---------------------------------------------------------------------------
// Data codeword assembly (with block interleaving).
// ---------------------------------------------------------------------------

function buildCodewords(data: number[], version: number, ec: QrEcLevel): number[] {
  const totalData = DATA_CODEWORDS[ec][version - 1];
  const bb = new BitBuffer();
  bb.put(0b0100, 4); // byte mode
  bb.put(data.length, byteCountBits(version));
  for (const byte of data) bb.put(byte, 8);
  // Terminator (up to 4 zero bits).
  const capacityBits = totalData * 8;
  const term = Math.min(4, capacityBits - bb.length);
  if (term > 0) bb.put(0, term);
  // Pad to a byte boundary.
  while (bb.length % 8 !== 0) bb.bits.push(0);
  // Pad bytes 0xEC / 0x11 alternating.
  const dataCw: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i + j];
    dataCw.push(v);
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (dataCw.length < totalData) dataCw.push(pads[p++ % 2]);

  // Split into blocks and compute ECC per block.
  const [ecPerBlock, g1, g1Words, g2, g2Words] = EC_BLOCKS[ec][version - 1];
  const blocks: { data: number[]; ec: number[] }[] = [];
  let idx = 0;
  for (let b = 0; b < g1; b++) {
    const slice = dataCw.slice(idx, idx + g1Words);
    idx += g1Words;
    blocks.push({ data: slice, ec: rsEncode(slice, ecPerBlock) });
  }
  for (let b = 0; b < g2; b++) {
    const slice = dataCw.slice(idx, idx + g2Words);
    idx += g2Words;
    blocks.push({ data: slice, ec: rsEncode(slice, ecPerBlock) });
  }

  // Interleave data codewords, then EC codewords.
  const result: number[] = [];
  const maxDataLen = Math.max(g1Words, g2Words);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of blocks) result.push(block.ec[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matrix placement.
// ---------------------------------------------------------------------------

type Matrix = Int8Array[]; // -1 = empty, 0/1 = module value, 2/3 = reserved (function)

function emptyMatrix(size: number): Matrix {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

const ALIGN_POS: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
  [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
  [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

function placeFinder(m: Matrix, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
      const inner =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      m[rr][cc] = inner ? 1 : 0;
      // mark as reserved (function pattern) by using value+2? We keep a separate
      // reserved set below; here values are final 0/1.
    }
  }
}

function placeFunctionPatterns(m: Matrix, version: number, reserved: boolean[][]): void {
  const size = m.length;
  const mark = (r: number, c: number) => {
    if (r >= 0 && r < size && c >= 0 && c < size) reserved[r][c] = true;
  };

  // Finder patterns + their separators (reserve an 8x8 region in each corner).
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      mark(r, c);
      mark(r, size - 1 - c);
      mark(size - 1 - r, c);
    }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (m[6][i] === -1) {
      m[6][i] = bit;
      mark(6, i);
    }
    if (m[i][6] === -1) {
      m[i][6] = bit;
      mark(i, 6);
    }
  }

  // Alignment patterns (skip ones overlapping finders).
  const centers = ALIGN_POS[version - 1] ?? [];
  for (const r of centers) {
    for (const c of centers) {
      const nearFinder =
        (r <= 7 && c <= 7) || (r <= 7 && c >= size - 8) || (r >= size - 8 && c <= 7);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr][c + dc] = ring === 1 ? 0 : 1;
          mark(r + dr, c + dc);
        }
      }
    }
  }

  // Dark module.
  m[size - 8][8] = 1;
  mark(size - 8, 8);

  // Reserve format-info areas.
  for (let i = 0; i < 9; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }

  // Reserve version-info areas (version >= 7).
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        mark(i, size - 11 + j);
        mark(size - 11 + j, i);
      }
    }
  }
}

function placeData(m: Matrix, reserved: boolean[][], codewords: number[]): void {
  const size = m.length;
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let bitIdx = 0;
  // Walk column pairs from the right. `right` is the right column of each pair;
  // when it would land on (or past) the vertical timing column at x=6, shift it
  // left by one so the timing column is skipped. The up/down direction is
  // derived from the column index (NOT a per-iteration toggle) so the parity is
  // correct across the timing-column shift — this matches the ISO 18004 order
  // that decoders (and reference encoders) use.
  let pair = 0;
  for (let right = size - 1; right >= 1; right -= 2, pair++) {
    if (right === 6) right = 5;
    const upward = pair % 2 === 0;
    for (let v = 0; v < size; v++) {
      const row = upward ? size - 1 - v : v;
      for (let c = 0; c < 2; c++) {
        const cc = right - c;
        if (reserved[row][cc]) continue;
        m[row][cc] = bitIdx < bits.length ? bits[bitIdx] : 0;
        bitIdx++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Masking + format/version info.
// ---------------------------------------------------------------------------

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function applyMask(m: Matrix, reserved: boolean[][], mask: number): Matrix {
  const size = m.length;
  const out = m.map((row) => Int8Array.from(row));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if (maskCondition(mask, r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

const EC_FORMAT_BITS: Record<QrEcLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

function formatInfoBits(ec: QrEcLevel, mask: number): number {
  const data = (EC_FORMAT_BITS[ec] << 3) | mask; // 5 bits
  let rem = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= g << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function placeFormatInfo(m: Matrix, ec: QrEcLevel, mask: number): void {
  const size = m.length;
  const bits = formatInfoBits(ec, mask);
  // Bit 14 (MSB) is placed first; `bit(k)` extracts the k-th bit (LSB k=0).
  const bit = (k: number) => (bits >> k) & 1;

  // Copy 1 — wraps the top-left finder. The 15 bits run along row 8 (left→the
  // finder), then turn and run up column 8 (finder→top), MSB-first.
  // Horizontal: cols 0..5, 7, 8 carry bits 14..7 (col 6 is the timing line).
  m[8][0] = bit(14);
  m[8][1] = bit(13);
  m[8][2] = bit(12);
  m[8][3] = bit(11);
  m[8][4] = bit(10);
  m[8][5] = bit(9);
  m[8][7] = bit(8);
  m[8][8] = bit(7);
  // Vertical: rows 7,5,4,3,2,1,0 (row 6 is the timing line) carry bits 6..0.
  m[7][8] = bit(6);
  m[5][8] = bit(5);
  m[4][8] = bit(4);
  m[3][8] = bit(3);
  m[2][8] = bit(2);
  m[1][8] = bit(1);
  m[0][8] = bit(0);

  // Copy 2 — split across the other two finders. Down column 8 from the bottom
  // carries bits 14..8; along row 8 from the right carries bits 7..0.
  for (let i = 0; i < 7; i++) m[size - 1 - i][8] = bit(14 - i);
  for (let i = 0; i < 8; i++) m[8][size - 8 + i] = bit(7 - i);
}

function versionInfoBits(version: number): number {
  let rem = version << 12;
  const g = 0b1111100100101;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= g << (i - 12);
  }
  return (version << 12) | rem;
}

function placeVersionInfo(m: Matrix, version: number): void {
  if (version < 7) return;
  const size = m.length;
  const bits = versionInfoBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[r][size - 11 + c] = bit;
    m[size - 11 + c][r] = bit;
  }
}

function maskPenalty(m: Matrix): number {
  const size = m.length;
  let penalty = 0;
  // Rule 1: runs of 5+ same-colour modules in rows and columns.
  for (let r = 0; r < size; r++) {
    let runC = 1, runR = 1;
    for (let c = 1; c < size; c++) {
      if (m[r][c] === m[r][c - 1]) { runC++; if (runC === 5) penalty += 3; else if (runC > 5) penalty++; }
      else runC = 1;
      if (m[c][r] === m[c - 1][r]) { runR++; if (runR === 5) penalty += 3; else if (runR > 5) penalty++; }
      else runR = 1;
    }
  }
  // Rule 2: 2x2 blocks of the same colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) penalty += 3;
    }
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns.
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (arr: number[], r: number, c: number, horiz: boolean) => {
    for (let k = 0; k < 11; k++) {
      const v = horiz ? m[r][c + k] : m[r + k][c];
      if (v !== arr[k]) return false;
    }
    return true;
  };
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      if (matches(pat1, r, c, true) || matches(pat2, r, c, true)) penalty += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 11; r++) {
      if (matches(pat1, r, c, false) || matches(pat2, r, c, false)) penalty += 40;
    }
  }
  // Rule 4: proportion of dark modules.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return penalty;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** A rendered QR: a square boolean matrix (`true` = dark module). */
export interface QrMatrix {
  size: number;
  version: number;
  modules: boolean[][];
}

/**
 * Encode a string into a QR module matrix (byte mode, auto version + mask).
 * Throws {@link QrTooLargeError} when the data does not fit version 40.
 */
export function encodeQr(text: string, ec: QrEcLevel = 'L'): QrMatrix {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length, ec);
  if (version === 0) throw new QrTooLargeError(bytes.length, maxByteCapacity(ec));

  const codewords = buildCodewords(bytes, version, ec);
  const size = sizeForVersion(version);

  const base = emptyMatrix(size);
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  placeFunctionPatterns(base, version, reserved);
  placeData(base, reserved, codewords);

  // Try all 8 masks, keep the lowest penalty.
  let best: Matrix | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(base, reserved, mask);
    placeFormatInfo(masked, ec, mask);
    placeVersionInfo(masked, version);
    const score = maskPenalty(masked);
    if (score < bestScore) {
      bestScore = score;
      best = masked;
      bestMask = mask;
    }
  }
  // best is non-null (loop runs); placeFormatInfo already applied for bestMask.
  void bestMask;

  const finalMatrix = best as Matrix;
  const modules = finalMatrix.map((row) => Array.from(row, (v) => v === 1));
  return { size, version, modules };
}

/** True when `text` fits a QR at the given EC level (does not throw). */
export function fitsInQr(text: string, ec: QrEcLevel = 'L'): boolean {
  return utf8Bytes(text).length <= maxByteCapacity(ec);
}
