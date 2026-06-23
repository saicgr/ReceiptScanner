/**
 * Unit tests for src/lib/receiptQr.ts — the PURE QR payload logic behind the
 * data-only share (TASK 70), the cloud-link share (TASK 69) and the scan
 * classifier + fiscal stubs (TASK 68).
 *
 * Covers: encode→decode round-trip of the core fields, the oversize → file
 * fallback signal (a QR caps ~2953 bytes), link-envelope classification, plain
 * URL vs unknown classification, payload→ExtractionResult mapping, and the
 * best-effort EU fiscal-format detection/parsing.
 */
import {
  QR_BYTE_CAP,
  classifyScannedQr,
  detectFiscalRegion,
  encodeDataEnvelope,
  encodeLinkEnvelope,
  encodeReceiptForQr,
  parseFiscalReceipt,
  payloadFromReceipt,
  payloadToExtraction,
  type ReceiptCoreFields,
} from '../receiptQr';

const sample = (overrides: Partial<ReceiptCoreFields> = {}): ReceiptCoreFields => ({
  vendor: 'Café Müller',
  date: '2026-06-22',
  total: 42.5,
  tax: 3.5,
  currency: 'eur',
  line_items: [
    { name: 'Espresso', qty: 2, price: 3.5 },
    { name: 'Croissant', qty: 1, price: 2.0 },
  ],
  ...overrides,
});

describe('payloadFromReceipt', () => {
  it('compacts core fields with short keys and uppercases currency', () => {
    const p = payloadFromReceipt(sample());
    expect(p.v).toBe('Café Müller');
    expect(p.d).toBe('2026-06-22');
    expect(p.t).toBe(42.5);
    expect(p.x).toBe(3.5);
    expect(p.c).toBe('EUR');
    expect(p.li).toEqual([
      { n: 'Espresso', q: 2, p: 3.5 },
      { n: 'Croissant', q: 1, p: 2.0 },
    ]);
  });

  it('keeps null tax and null date as null', () => {
    const p = payloadFromReceipt(sample({ tax: null, date: null }));
    expect(p.x).toBeNull();
    expect(p.d).toBeNull();
  });

  it('rounds money to 2dp', () => {
    const p = payloadFromReceipt(sample({ total: 10.005, tax: 1.004 }));
    expect(p.t).toBe(10.01);
    expect(p.x).toBe(1.0);
  });
});

describe('encode → classify round-trip (TASK 70)', () => {
  it('fits a normal receipt in a QR and decodes back to the same fields', () => {
    const result = encodeReceiptForQr(sample());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.byteLength).toBeLessThanOrEqual(QR_BYTE_CAP);

    const scanned = classifyScannedQr(result.text);
    expect(scanned.kind).toBe('data');
    if (scanned.kind !== 'data') throw new Error('expected data');
    expect(scanned.payload).toEqual(payloadFromReceipt(sample()));
  });

  it('round-trips unicode + special characters intact', () => {
    const r = sample({ vendor: '日本＆Co "Quotes"', line_items: [{ name: 'Tëa ☕', qty: 1, price: 9.99 }] });
    const result = encodeReceiptForQr(r);
    if (!result.ok) throw new Error('expected ok');
    const scanned = classifyScannedQr(result.text);
    if (scanned.kind !== 'data') throw new Error('expected data');
    expect(scanned.payload.v).toBe('日本＆Co "Quotes"');
    expect(scanned.payload.li[0].n).toBe('Tëa ☕');
  });
});

describe('oversize → file fallback (TASK 70)', () => {
  it('reports too_large when the payload exceeds the QR byte cap', () => {
    // Many long line items push the JSON well past 2953 bytes.
    const items = Array.from({ length: 400 }, (_, i) => ({
      name: `Very long product description number ${i} with extra words`,
      qty: 1,
      price: 1.23,
    }));
    const result = encodeReceiptForQr(sample({ line_items: items }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected too large');
    expect(result.reason).toBe('too_large');
    expect(result.byteLength).toBeGreaterThan(result.cap);
    expect(result.cap).toBe(QR_BYTE_CAP);
    // The would-be text is still valid JSON we could write to a file.
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  it('a single huge item just under nothing still classifies as data when it fits', () => {
    const result = encodeReceiptForQr(sample());
    if (!result.ok) throw new Error('expected ok');
    expect(classifyScannedQr(result.text).kind).toBe('data');
  });
});

describe('classifyScannedQr (TASK 68)', () => {
  it('recognises our cloud-link envelope', () => {
    const text = encodeLinkEnvelope('https://drive.google.com/file/abc', 'Acme');
    const scanned = classifyScannedQr(text);
    expect(scanned.kind).toBe('link');
    if (scanned.kind !== 'link') throw new Error('expected link');
    expect(scanned.url).toBe('https://drive.google.com/file/abc');
    expect(scanned.vendor).toBe('Acme');
  });

  it('classifies a plain http(s) URL as a url e-receipt', () => {
    expect(classifyScannedQr('https://receipts.example.com/r/123').kind).toBe('url');
    expect(classifyScannedQr('http://shop.example/abc').kind).toBe('url');
  });

  it('classifies junk / non-URL text as unknown', () => {
    expect(classifyScannedQr('hello world').kind).toBe('unknown');
    expect(classifyScannedQr('').kind).toBe('unknown');
  });

  it('does not mistake foreign JSON for our envelope', () => {
    expect(classifyScannedQr('{"k":"other","x":1}').kind).toBe('unknown');
    expect(classifyScannedQr('{not json').kind).toBe('unknown');
  });

  it('hardens malformed data envelopes (junk numbers default safely)', () => {
    const text = JSON.stringify({ k: 'rcptsnap', ver: 1, ty: 'd', r: { v: 5, t: 'NaN', li: 'x' } });
    const scanned = classifyScannedQr(text);
    expect(scanned.kind).toBe('data');
    if (scanned.kind !== 'data') throw new Error('expected data');
    expect(scanned.payload.v).toBe('');
    expect(scanned.payload.t).toBe(0);
    expect(scanned.payload.li).toEqual([]);
    expect(scanned.payload.c).toBe('USD');
  });
});

describe('payloadToExtraction (TASK 68 import)', () => {
  it('maps a payload to an editable ExtractionResult (image-free, reviewable)', () => {
    const p = payloadFromReceipt(sample());
    const ex = payloadToExtraction(p);
    expect(ex.vendor).toBe('Café Müller');
    expect(ex.date).toBe('2026-06-22');
    expect(ex.total).toBe(42.5);
    expect(ex.tax).toBe(3.5);
    expect(ex.currency).toBe('EUR');
    expect(ex.line_items).toHaveLength(2);
    expect(ex.line_items[0]).toMatchObject({ name: 'Espresso', qty: 2, price: 3.5 });
    // Nothing auto-finalized: confidence is non-high so the importer reviews.
    expect(ex.date_confidence).toBe('medium');
    expect(ex.date_ambiguous).toBe(false);
  });
});

describe('EU fiscal stubs (TASK 68, best-effort)', () => {
  it('detects RKSV (Austria) and DSFinV-K (Germany) prefixes', () => {
    expect(detectFiscalRegion('_R1-AT1_cashbox_0001_2026-06-22_4,50_0,00')).toBe('at_rksv');
    expect(detectFiscalRegion('V0;client42;Kassenbeleg;Beleg^4.50^;...')).toBe('de_dsfinv_k');
    expect(detectFiscalRegion('https://finanzonline.bmf.gv.at/verify?x=1')).toBe('at_rksv');
    expect(detectFiscalRegion('just some text')).toBeNull();
  });

  it('classifies a fiscal code as kind=fiscal with region + raw', () => {
    const scanned = classifyScannedQr('_R1-AT0_box_1_2026-06-22_9,90');
    expect(scanned.kind).toBe('fiscal');
    if (scanned.kind !== 'fiscal') throw new Error('expected fiscal');
    expect(scanned.region).toBe('at_rksv');
  });

  it('parses best-effort fields and flags them as bestEffort', () => {
    const at = parseFiscalReceipt('_R1-AT1_BOX01_REC42_2026-06-22_19,90_0,00');
    expect(at).not.toBeNull();
    expect(at?.region).toBe('at_rksv');
    expect(at?.label).toBe('Austria (RKSV)');
    expect(at?.registerId).toBe('BOX01'); // cashbox id = 3rd underscore field
    expect(at?.bestEffort).toBe(true);

    expect(parseFiscalReceipt('not fiscal')).toBeNull();
  });
});

describe('encodeDataEnvelope shape', () => {
  it('stamps the schema marker + type so scanners recognise it', () => {
    const env = JSON.parse(encodeDataEnvelope(payloadFromReceipt(sample())));
    expect(env.k).toBe('rcptsnap');
    expect(env.ty).toBe('d');
    expect(env.ver).toBe(1);
    expect(env.r.v).toBe('Café Müller');
  });
});
