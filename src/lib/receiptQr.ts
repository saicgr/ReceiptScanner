/**
 * receiptQr — pure encode/decode + classification for the QR sharing features.
 *
 * Three responsibilities, all pure (no native/async deps) so they are fully
 * unit-testable:
 *
 *  1. DATA-ONLY share (TASK 70): pack a receipt's CORE fields into a compact
 *     JSON envelope that fits in a single QR. Another ReceiptSnap install scans
 *     it and imports a new receipt (status 'pending', for review). The image is
 *     NEVER part of the payload — only structured fields travel. If the encoded
 *     payload is too large for a QR, the caller is told to fall back to a data
 *     file rather than draw a broken/truncated code.
 *
 *  2. LINK share (TASK 69): wrap a cloud share URL (Drive/OneDrive) — to the
 *     full backed-up receipt incl. image — in a tiny envelope. We host nothing;
 *     the link points at the user's OWN cloud.
 *
 *  3. SCAN classification (TASK 68): given the raw string a QR decodes to,
 *     decide whether it is one of OUR payloads (data / link) or a plain URL /
 *     fiscal-receipt string, so the scanner can route it correctly. Stub
 *     parsers for EU fiscal formats (RKSV Austria, DSFinV-K Germany) are
 *     included behind a clearly-labelled, best-effort region flag.
 */
import type { ExtractedLineItem, ExtractionResult } from '@/types';
import { maxByteCapacity, utf8Bytes } from './qrEncode';

/** Schema marker so we can recognise (and version) our own QR payloads. */
const ENVELOPE_KIND = 'rcptsnap';
const ENVELOPE_VERSION = 1;

/**
 * Hard QR byte cap. A QR maxes out around 2953 bytes (version 40, EC level L);
 * we mirror that here so {@link encodeReceiptForQr} can detect an oversize
 * payload and signal a file fallback BEFORE attempting to draw anything.
 */
export const QR_BYTE_CAP = maxByteCapacity('L'); // 2953

// ---------------------------------------------------------------------------
// Core payload shapes
// ---------------------------------------------------------------------------

/** A single line item in the compact payload (short keys to save QR bytes). */
export interface QrLineItem {
  /** name */ n: string;
  /** qty */ q: number;
  /** price (unit) */ p: number;
}

/** The data-only receipt payload (TASK 70). Short keys keep it QR-compact. */
export interface ReceiptQrPayload {
  /** vendor */ v: string;
  /** date (ISO YYYY-MM-DD) or null */ d: string | null;
  /** total */ t: number;
  /** tax or null */ x: number | null;
  /** currency (ISO 4217) */ c: string;
  /** line items */ li: QrLineItem[];
}

/** The full data-only envelope written into the QR. */
export interface ReceiptDataEnvelope {
  k: typeof ENVELOPE_KIND;
  ver: number;
  /** type: data-only receipt */ ty: 'd';
  r: ReceiptQrPayload;
}

/** The link envelope written into the QR (TASK 69). */
export interface ReceiptLinkEnvelope {
  k: typeof ENVELOPE_KIND;
  ver: number;
  /** type: cloud link */ ty: 'l';
  /** cloud share url */ u: string;
  /** optional vendor label for a nicer scan preview */ v?: string;
}

/** Minimal source fields needed to build a data payload (matches Receipt). */
export interface ReceiptCoreFields {
  vendor: string;
  date: string | null;
  total: number;
  tax: number | null;
  currency: string;
  line_items: { name: string; qty: number; price: number }[];
}

// ---------------------------------------------------------------------------
// Encode (data-only) — TASK 70
// ---------------------------------------------------------------------------

/** Round to 2 dp without floating-point noise (keeps payloads tidy). */
function money2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Build the compact data-only payload from a receipt's core fields. */
export function payloadFromReceipt(receipt: ReceiptCoreFields): ReceiptQrPayload {
  return {
    v: receipt.vendor ?? '',
    d: receipt.date ?? null,
    t: money2(receipt.total ?? 0),
    x: receipt.tax == null ? null : money2(receipt.tax),
    c: (receipt.currency || 'USD').toUpperCase(),
    li: (receipt.line_items ?? []).map((li) => ({
      n: li.name ?? '',
      q: Number(li.qty) || 0,
      p: money2(li.price ?? 0),
    })),
  };
}

/** Serialize a data-only payload into the string that goes inside the QR. */
export function encodeDataEnvelope(payload: ReceiptQrPayload): string {
  const env: ReceiptDataEnvelope = {
    k: ENVELOPE_KIND,
    ver: ENVELOPE_VERSION,
    ty: 'd',
    r: payload,
  };
  return JSON.stringify(env);
}

/** Serialize a cloud-link payload into the string that goes inside the QR. */
export function encodeLinkEnvelope(url: string, vendor?: string): string {
  const env: ReceiptLinkEnvelope = {
    k: ENVELOPE_KIND,
    ver: ENVELOPE_VERSION,
    ty: 'l',
    u: url,
    ...(vendor ? { v: vendor } : {}),
  };
  return JSON.stringify(env);
}

/** The outcome of trying to fit a receipt into a data-only QR. */
export type EncodeForQrResult =
  | { ok: true; text: string; byteLength: number }
  | { ok: false; reason: 'too_large'; text: string; byteLength: number; cap: number };

/**
 * Prepare a receipt's data-only QR string AND check it fits.
 *
 * Returns `ok: true` with the string to encode when it fits in a single QR, or
 * `ok: false, reason: 'too_large'` (carrying the would-be string + sizes) so the
 * caller can fall back to exporting a data FILE instead of drawing a broken QR.
 * Never throws.
 */
export function encodeReceiptForQr(receipt: ReceiptCoreFields): EncodeForQrResult {
  const text = encodeDataEnvelope(payloadFromReceipt(receipt));
  const byteLength = utf8Bytes(text).length;
  if (byteLength > QR_BYTE_CAP) {
    return { ok: false, reason: 'too_large', text, byteLength, cap: QR_BYTE_CAP };
  }
  return { ok: true, text, byteLength };
}

// ---------------------------------------------------------------------------
// Decode + classify — TASK 68
// ---------------------------------------------------------------------------

/** What a scanned QR turned out to be. */
export type ScannedQr =
  | { kind: 'data'; payload: ReceiptQrPayload }
  | { kind: 'link'; url: string; vendor: string | null }
  | { kind: 'url'; url: string }
  | { kind: 'fiscal'; region: FiscalRegion; url: string | null; raw: string }
  | { kind: 'unknown'; raw: string };

/** Best-effort EU fiscal-receipt regions we recognise (stub parsers). */
export type FiscalRegion = 'at_rksv' | 'de_dsfinv_k';

/** Coerce an unknown value to a finite number, or a fallback. */
function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

/** Validate + normalise a decoded data payload (defensive against junk). */
function normalizePayload(raw: unknown): ReceiptQrPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const items = Array.isArray(r.li) ? r.li : [];
  return {
    v: typeof r.v === 'string' ? r.v : '',
    d: typeof r.d === 'string' && r.d.trim() ? r.d.trim() : null,
    t: money2(num(r.t)),
    x: r.x == null ? null : money2(num(r.x)),
    c: typeof r.c === 'string' && r.c.trim() ? r.c.trim().toUpperCase() : 'USD',
    li: items.map((it) => {
      const o = (it ?? {}) as Record<string, unknown>;
      return { n: typeof o.n === 'string' ? o.n : '', q: num(o.q, 1), p: money2(num(o.p)) };
    }),
  };
}

/** True for an http(s) URL string. */
function isHttpUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

/**
 * Classify the raw string a QR decoded to. Pure + total — always returns a
 * `ScannedQr` (never throws), so the scanner UI can switch on `kind`.
 */
export function classifyScannedQr(raw: string): ScannedQr {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'unknown', raw: text };

  // 1) Our own JSON envelope (data or link).
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      if (obj.k === ENVELOPE_KIND) {
        if (obj.ty === 'd') {
          const payload = normalizePayload(obj.r);
          if (payload) return { kind: 'data', payload };
        }
        if (obj.ty === 'l' && typeof obj.u === 'string') {
          return { kind: 'link', url: obj.u, vendor: typeof obj.v === 'string' ? obj.v : null };
        }
      }
    } catch {
      // Not our JSON — fall through to the other classifiers.
    }
  }

  // 2) EU fiscal receipt formats (best-effort stub detection).
  const fiscal = detectFiscalRegion(text);
  if (fiscal) {
    return { kind: 'fiscal', region: fiscal, url: isHttpUrl(text) ? text : null, raw: text };
  }

  // 3) A plain URL (e-receipt link) — fetch + run through the extract pipeline.
  if (isHttpUrl(text)) return { kind: 'url', url: text };

  // 4) Anything else.
  return { kind: 'unknown', raw: text };
}

/** Convert a decoded data payload into the app's ExtractionResult contract so
 *  the existing draft/import pipeline can consume it unchanged. */
export function payloadToExtraction(payload: ReceiptQrPayload): ExtractionResult {
  const line_items: ExtractedLineItem[] = payload.li.map((li) => ({
    name: li.n,
    qty: Number(li.q) || 1,
    price: money2(li.p),
    return_window_days: null,
    warranty_period_days: null,
  }));
  return {
    vendor: payload.v,
    date: payload.d,
    // Shared receipts were reviewed by the sender; treat fields as medium —
    // the importer still reviews everything (nothing is auto-finalized).
    date_confidence: 'medium',
    date_ambiguous: false,
    date_options: payload.d ? [payload.d] : [],
    total: money2(payload.t),
    tax: payload.x == null ? null : money2(payload.x),
    currency: payload.c,
    line_items,
    field_confidence: { vendor: 'medium', date: 'medium', total: 'medium', tax: 'medium' },
    return_window_days: null,
    warranty_period_days: null,
    category: null,
    tax_category: null,
    is_deductible: null,
    deductible_percent: null,
    condition: ['digital'],
  };
}

// ---------------------------------------------------------------------------
// EU fiscal-receipt stub parsers (TASK 68) — clearly best-effort.
//
// These DETECT (and partially parse) the QR formats mandated for cash registers
// in Austria (RKSV) and Germany (KassenSichV / DSFinV-K). Full extraction of
// these signed, compact formats is out of scope; we recognise them so the
// scanner can label the result as an EU fiscal receipt and, where the QR is a
// verification URL, route it through the normal URL → extract pipeline. Marked
// EU-oriented / best-effort so users know not to rely on full field parsing.
// ---------------------------------------------------------------------------

/** RKSV (Austria) machine-readable receipt code prefix, e.g. "_R1-AT0_...". */
const RKSV_RE = /^_R\d-AT\d/i;

/**
 * DSFinV-K / KassenSichV (Germany) TSE QR payloads are 'V0;'-prefixed
 * semicolon-delimited fields, OR a verification URL on some POS systems.
 */
const DSFINVK_RE = /^V0;/i;

/** Detect a known EU fiscal-receipt format from a raw QR string, or null. */
export function detectFiscalRegion(raw: string): FiscalRegion | null {
  const text = (raw ?? '').trim();
  if (RKSV_RE.test(text)) return 'at_rksv';
  if (DSFINVK_RE.test(text)) return 'de_dsfinv_k';
  // Some Austrian/German verification QRs are plain URLs to the tax authority.
  if (/finanzonline|bmf\.gv\.at/i.test(text)) return 'at_rksv';
  return null;
}

/** Loosely-parsed fields a fiscal stub can surface (all optional/best-effort). */
export interface FiscalReceiptStub {
  region: FiscalRegion;
  /** A short human label for the region. */
  label: string;
  /** Cash-register / TSE id if we could spot one. */
  registerId: string | null;
  /** Receipt total if it appears in a known field position. */
  total: number | null;
  /** A verification URL when the payload is (or contains) one. */
  url: string | null;
  /** True — these parsers are intentionally partial. */
  bestEffort: true;
}

/**
 * Best-effort parse of a detected fiscal QR. Returns null when the string is not
 * a recognised fiscal format. NEVER throws and never claims more than it knows
 * (most fields stay null) — the scanner presents this as "EU fiscal receipt
 * (best-effort)" and lets the user fall back to a normal photo scan.
 */
export function parseFiscalReceipt(raw: string): FiscalReceiptStub | null {
  const region = detectFiscalRegion(raw);
  if (!region) return null;
  const text = (raw ?? '').trim();
  const url = isHttpUrl(text) ? text : null;

  if (region === 'at_rksv') {
    // _R1-AT1_<cashbox-id>_<receipt-id>_<date>_<sum-normal>_..._<signature>
    const parts = text.split('_');
    const registerId = parts.length > 2 && parts[2] ? parts[2] : null;
    // Austrian amounts use a comma decimal; field 6 is the standard-rate sum.
    const total = parts.length > 6 ? safeAmount(parts[6]) : null;
    return { region, label: 'Austria (RKSV)', registerId, total, url, bestEffort: true };
  }

  // de_dsfinv_k: "V0;<client-id>;<process-type>;<process-data>;..." — process
  // data sometimes contains "Beleg^<brutto>^..." but layouts vary by TSE, so we
  // only surface the client id and any embedded amount we can see.
  const fields = text.split(';');
  const registerId = fields.length > 1 && fields[1] ? fields[1] : null;
  const amountMatch = text.match(/\^(\d+[.,]\d{2})\^/);
  const total = amountMatch ? safeAmount(amountMatch[1]) : null;
  return { region, label: 'Germany (DSFinV-K)', registerId, total, url, bestEffort: true };
}

/** Parse a "12,34" / "12.34" amount string to a number, or null. */
function safeAmount(s: string): number | null {
  const n = parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? money2(n) : null;
}
