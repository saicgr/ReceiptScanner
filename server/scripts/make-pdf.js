// Minimal multi-page PDF generator (pure Node, no deps) used to build a
// realistic MULTI-PAGE grocery receipt for the gauntlet — mirroring the kind of
// long grocery receipt the competitor markets its Multi-Scan for. Emits a valid
// PDF 1.4 with Helvetica text and a correct xref table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Build a content stream that prints `lines` from the top of the page. */
function contentStream(lines) {
  let body = 'BT\n/F1 11 Tf\n12 TL\n56 760 Td\n';
  lines.forEach((line, i) => {
    if (i === 0) body += `(${esc(line)}) Tj\n`;
    else body += `T*\n(${esc(line)}) Tj\n`;
  });
  body += 'ET';
  return body;
}

/**
 * @param {string[][]} pages  array of pages, each an array of text lines
 * @returns {Buffer} the PDF bytes
 */
export function makePdf(pages) {
  const objects = []; // index 1-based; objects[0] is obj #1
  const pageCount = pages.length;

  // Reserve object numbers:
  // 1 = Catalog, 2 = Pages, then for each page: a Page obj + a Contents obj,
  // and finally 1 Font object.
  const pageObjNums = [];
  const contentObjNums = [];
  let next = 3;
  for (let i = 0; i < pageCount; i++) {
    pageObjNums.push(next++);
    contentObjNums.push(next++);
  }
  const fontObjNum = next++;

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>`;

  pages.forEach((lines, i) => {
    const pNum = pageObjNums[i];
    const cNum = contentObjNums[i];
    objects[pNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${cNum} 0 R >>`;
    const stream = contentStream(lines);
    objects[cNum] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  objects[fontObjNum] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  // Serialize with a correct xref table.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  const count = objects.length; // includes free object 0
  pdf += `xref\n0 ${count}\n`;
  pdf += `0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) {
    pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

/** The competitor's "Sample Receipt": a EUR grocery receipt, split over 2 pages. */
export function makeGroceryReceiptPdf() {
  const page1 = [
    'SAMPLE COMPANY',
    '123 Market Street, Springfield',
    'VAT: EU1234567  Tel: 555-0100',
    '----------------------------------------',
    'Receipt #: PR-40292',
    'Date: 02/03/2026  17:40',
    'Payment: Debit Card    Currency: EUR',
    '----------------------------------------',
    'Milk (1L)              x1        3.20',
    'Bread (Whole Wheat)    x1        2.10',
    'Eggs (12 pack)         x1        4.00',
    'Orange Juice (1L)      x1        3.30',
    '(continued on next page...)',
  ];
  const page2 = [
    'SAMPLE COMPANY  —  Receipt PR-40292 (page 2)',
    '----------------------------------------',
    'Pasta (500g)           x2        2.98',
    'Chicken Breast (kg)    x0.75     7.20',
    'Tomatoes (500g)        x1        1.50',
    '----------------------------------------',
    'Subtotal                        24.28',
    'Tax (VAT 0%)                     0.00',
    'Bag fee                          1.00',
    'TOTAL                EUR        25.28',
    '----------------------------------------',
    'Thank you for shopping at Sample Company!',
  ];
  return makePdf([page1, page2]);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const dir = path.resolve(__dirname, '../fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'grocery_multipage.pdf');
  fs.writeFileSync(dest, makeGroceryReceiptPdf());
  console.log(`wrote ${dest} (${fs.statSync(dest).size} bytes, 2 pages)`);
}
