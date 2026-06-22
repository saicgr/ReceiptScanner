// Gemini Flash-Lite client + the receipt-extraction prompt.
//
// We call the Generative Language REST API directly (works for any model name,
// including gemini-3.1-flash-lite) rather than pinning an SDK version. The model
// is asked to return STRICT JSON matching the V1+V2 contract; we additionally
// harden parsing in case it wraps the JSON in a code fence.
import { config } from './config.js';

// The key travels in the x-goog-api-key header, NOT as a ?key= query param —
// query strings leak into access logs, proxies, and error messages.
function geminiUrl() {
  return `${config.gemini.baseUrl}/models/${config.gemini.model}:generateContent`;
}

function geminiHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': config.gemini.apiKey,
  };
}

// The JSON schema we request. Mirrors src/types ExtractionResult on the app side.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    vendor: { type: 'string' },
    date: { type: 'string', nullable: true },
    date_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    date_ambiguous: { type: 'boolean' },
    date_options: { type: 'array', items: { type: 'string' } },
    total: { type: 'number' },
    tax: { type: 'number', nullable: true },
    currency: { type: 'string' },
    field_confidence: {
      type: 'object',
      properties: {
        vendor: { type: 'string', enum: ['high', 'medium', 'low'] },
        date: { type: 'string', enum: ['high', 'medium', 'low'] },
        total: { type: 'string', enum: ['high', 'medium', 'low'] },
        tax: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          qty: { type: 'number' },
          price: { type: 'number' },
          return_window_days: { type: 'number', nullable: true },
          warranty_period_days: { type: 'number', nullable: true },
        },
        required: ['name', 'qty', 'price'],
      },
    },
    // V2 fields
    return_window_days: { type: 'number', nullable: true },
    warranty_period_days: { type: 'number', nullable: true },
    category: { type: 'string', nullable: true },
    tax_category: { type: 'string', nullable: true },
    is_deductible: { type: 'boolean', nullable: true },
    deductible_percent: { type: 'number', nullable: true },
    // V3: physical/quality condition attributes of the scanned receipt.
    condition: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['torn', 'folded', 'crumpled', 'faded', 'blurry', 'partial', 'long', 'handwritten', 'thermal', 'digital'],
      },
    },
  },
  required: [
    'vendor',
    'date',
    'date_confidence',
    'date_ambiguous',
    'total',
    'tax',
    'currency',
    'line_items',
  ],
};

function buildPrompt(ocrText, preferredDateFormat, categoryHints) {
  const catList = Array.isArray(categoryHints) && categoryHints.length
    ? categoryHints.join(', ')
    : '';
  return `You are an expert receipt-data extractor for a personal-finance app. You are given an OCR text dump and the original receipt image. Extract structured data and return ONLY a JSON object (no prose, no markdown fences).

If the image/text is clearly NOT a receipt or invoice (e.g. a photo of a person, animal, landscape, screenshot, or random object), DO NOT invent data: return vendor "", total 0, tax null, date null, empty line_items, all confidences "low", and condition []. Never fabricate a receipt.

Rules:
- vendor: the merchant/business name as printed.
- date: the purchase date in strict ISO format YYYY-MM-DD. If you cannot determine a date, use null.
- DATE DISAMBIGUATION (critical — this is the app's headline feature): Receipt dates are often ambiguous (e.g. "25/12/05", "01/02/03", "12/11/10"). You MUST set "date_ambiguous": true and enumerate EVERY plausible ISO interpretation in "date_options" (most-likely first) whenever ANY of these hold:
    * the year is written with 2 digits (e.g. "/04", "'04"), OR
    * the day and month are BOTH <= 12 (so D/M/Y and M/D/Y are both valid, e.g. "02/03/04"), OR
    * the separator/format is otherwise unclear.
  The user's preferred date format is "${preferredDateFormat || 'MM/DD/YYYY'}" — use it ONLY to order date_options (put the preferred-format reading first) and to set "date" to that most-likely option; do NOT use it as an excuse to suppress the ambiguity flag. The both-<=12 rule applies EVEN WITH A 4-DIGIT YEAR: "02/03/2026" is ambiguous (2026-02-03 vs 2026-03-02) and MUST be flagged with both options. Only set date_ambiguous=false when the date is genuinely unambiguous (a written month name, an ISO yyyy-mm-dd, or a day/month value that exceeds 12 and fixes the order). When unambiguous, date_options may be a single-element array (or []).
- date_confidence / field_confidence.*: "high" if clearly legible and unambiguous, "medium" if inferred, "low" if guessed or unreadable.
- total: the final grand total actually paid, as a number (no currency symbol). tax: the tax/VAT/GST amount as a number, or null if not shown.
- currency: ISO 4217 code inferred from symbols/locale (e.g. "$"->"USD", "£"->"GBP", "€"->"EUR"). Default "USD" only if truly unknown.
- line_items: every purchased line with name, qty (default 1 if not shown), and price (the UNIT price as a number). Do not include subtotal/tax/total rows as line items.
- WARRANTY & RETURNS (infer sensibly from merchant + item type; null when not inferable):
  * return_window_days at the receipt level: typical return window for this merchant (e.g. big-box retailer ~30, electronics ~15-30, grocery null).
  * warranty_period_days at the receipt level: typical manufacturer warranty for the most significant item (e.g. electronics ~365, appliances ~365-730, none for consumables -> null).
  * For each high-value/durable line item, also set its own return_window_days and warranty_period_days when meaningfully different; otherwise null.
- CATEGORY (spending category suggestion the user can override):${catList
    ? `\n  * category: choose the SINGLE best-matching name from this user list (return it EXACTLY as written): ${catList}. If none fit, return null.`
    : `\n  * category: a short spending-category name (e.g. "Groceries", "Dining", "Fuel", "Electronics", "Travel"), or null.`}
- TAX INTELLIGENCE (best-effort suggestions the user can override):
  * tax_category: one of "Meals (50%)", "Supplies", "Home Office", "Mileage / Vehicle", "Travel", "Equipment", "Advertising", "Utilities", "Not Deductible" — pick the closest, or null.
  * is_deductible: true if this expense is plausibly a business deduction, else false.
  * deductible_percent: 50 for meals, 100 for most business expenses, 0 if not deductible.
- CONDITION: an array describing the physical/quality state of the scanned receipt image, using ONLY these tags: "torn", "folded", "crumpled", "faded", "blurry", "partial" (cut off / not fully visible), "long" (unusually long, many items), "handwritten", "thermal" (thermal paper), "digital" (a PDF/screenshot e-receipt). Include only those that clearly apply; [] if none.

Be conservative: never invent line items or amounts that are not supported by the OCR text or image. Numbers must be plain numbers (e.g. 12.99, not "$12.99").

OCR TEXT:
"""
${(ocrText || '').slice(0, 8000)}
"""`;
}

/**
 * Extracts structured receipt data.
 * @param {{ ocrText?: string, imageBase64?: string, imageMimeType?: string, preferredDateFormat?: string }} input
 * @returns {Promise<object>} ExtractionResult JSON
 */
export async function extractReceipt(input) {
  const { ocrText, imageBase64, imageMimeType, preferredDateFormat, categoryHints } = input;

  const parts = [{ text: buildPrompt(ocrText, preferredDateFormat, categoryHints) }];
  if (imageBase64) {
    parts.push({
      inline_data: {
        mime_type: imageMimeType || 'image/jpeg',
        data: imageBase64,
      },
    });
  }

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      topP: 0.95,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  };

  const res = await fetchWithTimeout(
    geminiUrl(),
    {
      method: 'POST',
      headers: geminiHeaders(),
      body: JSON.stringify(body),
    },
    30000,
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // Some models reject responseSchema; retry once without it.
    if (res.status === 400 && /responseSchema|response_schema|Unknown name/i.test(errText)) {
      return extractReceiptNoSchema(parts);
    }
    const err = new Error(`Gemini ${res.status}: ${errText.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  return normalize(parseModelJson(json));
}

async function extractReceiptNoSchema(parts) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  };
  const res = await fetchWithTimeout(
    geminiUrl(),
    {
      method: 'POST',
      headers: geminiHeaders(),
      body: JSON.stringify(body),
    },
    30000,
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Gemini ${res.status}: ${errText.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return normalize(parseModelJson(json));
}

// ---------------------------------------------------------------------------
// Multi-receipt detection (OPTIONAL "Refine with AI" path)
//
// The app detects multiple receipts in one photo ON-DEVICE for free; this Gemini
// route is only hit when the user explicitly taps "Refine with AI" because the
// on-device split looked wrong. It returns one bounding box per receipt so the
// client can crop each into its own entry. Kept deliberately minimal/cheap.
// ---------------------------------------------------------------------------

const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    receipts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          // Gemini's standard 2D box convention: [ymin, xmin, ymax, xmax], 0..1000.
          box_2d: { type: 'array', items: { type: 'number' } },
          label: { type: 'string' },
        },
        required: ['box_2d'],
      },
    },
  },
  required: ['receipts'],
};

function buildDetectPrompt() {
  return `You are a document-segmentation system. The image may contain SEVERAL separate paper receipts laid out together (e.g. on a table or floor), or just one.

Detect EACH distinct physical receipt and return ONLY a JSON object:
{ "receipts": [ { "box_2d": [ymin, xmin, ymax, xmax], "label": "<short vendor hint>" } ] }
where box_2d values are integers 0..1000 normalized to the image (y = top→bottom, x = left→right).

Rules:
- One box per separate receipt. Do NOT merge two adjacent receipts into one box, and do NOT split a single long receipt into several boxes.
- Ignore background, hands, phones, and non-receipt clutter.
- Make each box tight around the receipt but include its full edges.
- If there is only ONE receipt, return exactly one box covering it.
- If there are NO receipts, return an empty array.`;
}

/**
 * Detect receipt bounding boxes in an image.
 * @param {{ imageBase64?: string, imageMimeType?: string }} input
 * @returns {Promise<{ count: number, regions: Array<{x:number,y:number,width:number,height:number,label:string|null}> }>}
 */
export async function detectReceipts({ imageBase64, imageMimeType }) {
  if (!imageBase64) return { count: 0, regions: [] };

  const parts = [
    { text: buildDetectPrompt() },
    { inline_data: { mime_type: imageMimeType || 'image/jpeg', data: imageBase64 } },
  ];
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: DETECT_SCHEMA,
    },
  };
  const res = await fetchWithTimeout(
    geminiUrl(),
    { method: 'POST', headers: geminiHeaders(), body: JSON.stringify(body) },
    30000,
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 400 && /responseSchema|response_schema|Unknown name/i.test(errText)) {
      // Some models reject responseSchema; retry once without it.
      const body2 = {
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: 'application/json' },
      };
      const res2 = await fetchWithTimeout(
        geminiUrl(),
        { method: 'POST', headers: geminiHeaders(), body: JSON.stringify(body2) },
        30000,
      );
      if (!res2.ok) {
        const e2 = await res2.text().catch(() => '');
        const err = new Error(`Gemini ${res2.status}: ${e2.slice(0, 500)}`);
        err.status = res2.status;
        throw err;
      }
      return normalizeRegions(parseModelJson(await res2.json()));
    }
    const err = new Error(`Gemini ${res.status}: ${errText.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }

  return normalizeRegions(parseModelJson(await res.json()));
}

/** Convert Gemini's [ymin,xmin,ymax,xmax] (0..1000) boxes to normalized regions. */
export function normalizeRegions(raw) {
  const arr = Array.isArray(raw?.receipts) ? raw.receipts : [];
  const regions = [];
  for (const r of arr) {
    const box = Array.isArray(r?.box_2d) ? r.box_2d.map(Number) : null;
    if (!box || box.length < 4 || !box.slice(0, 4).every(Number.isFinite)) continue;
    const [ymin, xmin, ymax, xmax] = box;
    let x = xmin / 1000;
    let y = ymin / 1000;
    let width = (xmax - xmin) / 1000;
    let height = (ymax - ymin) / 1000;
    // Clamp into the unit square.
    x = Math.min(Math.max(x, 0), 1);
    y = Math.min(Math.max(y, 0), 1);
    width = Math.min(Math.max(width, 0), 1 - x);
    height = Math.min(Math.max(height, 0), 1 - y);
    if (width < 0.03 || height < 0.03) continue; // drop slivers
    regions.push({
      x,
      y,
      width,
      height,
      label: typeof r.label === 'string' ? r.label.slice(0, 60) : null,
    });
  }
  return { count: regions.length, regions };
}

function parseModelJson(apiResponse) {
  const text =
    apiResponse?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || '')
      .join('') || '';
  if (!text) {
    throw new Error('Empty response from Gemini');
  }
  return parseJsonLoose(text);
}

/** Tolerant JSON parse: strips ```json fences and trailing commentary. */
export function parseJsonLoose(text) {
  let t = text.trim();
  // Strip code fences.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Grab the outermost object.
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

/** Coerce/repair the model output into the strict contract with safe defaults. */
export function normalize(raw) {
  const conf = (v) => (['high', 'medium', 'low'].includes(v) ? v : 'low');
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const lineItems = Array.isArray(raw.line_items) ? raw.line_items : [];

  // --- Date hardening: keep only REAL ISO calendar dates ---
  let options = (Array.isArray(raw.date_options) ? raw.date_options : [])
    .map(toIsoDate)
    .filter(Boolean);
  let date = toIsoDate(raw.date);
  // Dedupe options while preserving order.
  options = [...new Set(options)];
  // If the model gave a date not in options, prepend it.
  if (date && !options.includes(date)) options.unshift(date);
  // If date is missing/invalid but we have options, use the first.
  if (!date && options.length) date = options[0];
  if (date && options.length === 0) options = [date];
  // Ambiguity is only real when >1 valid interpretation survives.
  const ambiguous = Boolean(raw.date_ambiguous) && options.length > 1;

  return {
    vendor: typeof raw.vendor === 'string' ? raw.vendor.trim() : '',
    date,
    date_confidence: conf(raw.date_confidence),
    date_ambiguous: ambiguous,
    date_options: options,
    total: num(raw.total) ?? 0,
    tax: num(raw.tax),
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency.toUpperCase() : 'USD',
    field_confidence: {
      vendor: conf(raw.field_confidence?.vendor ?? raw.date_confidence),
      date: conf(raw.field_confidence?.date ?? raw.date_confidence),
      total: conf(raw.field_confidence?.total),
      tax: conf(raw.field_confidence?.tax),
    },
    line_items: lineItems.map((li) => ({
      name: typeof li.name === 'string' ? li.name.trim() : '',
      qty: num(li.qty) ?? 1,
      price: num(li.price) ?? 0,
      return_window_days: num(li.return_window_days),
      warranty_period_days: num(li.warranty_period_days),
    })),
    // V2
    return_window_days: num(raw.return_window_days),
    warranty_period_days: num(raw.warranty_period_days),
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : null,
    tax_category: typeof raw.tax_category === 'string' ? raw.tax_category : null,
    is_deductible: raw.is_deductible === null || raw.is_deductible === undefined ? null : Boolean(raw.is_deductible),
    deductible_percent: num(raw.deductible_percent),
    // V3: filter condition tags to the known vocabulary.
    condition: Array.isArray(raw.condition)
      ? raw.condition.filter((c) => CONDITION_VOCAB.has(c))
      : [],
  };
}

const CONDITION_VOCAB = new Set([
  'torn', 'folded', 'crumpled', 'faded', 'blurry', 'partial', 'long', 'handwritten', 'thermal', 'digital',
]);

/**
 * Coerces a value to a valid ISO YYYY-MM-DD string or null. Rejects malformed
 * months/days (e.g. "2005-25-12") and non-existent dates (e.g. "2021-02-30").
 * Accepts a bare YYYY-MM-DD; also tolerates a leading ISO datetime.
 */
export function toIsoDate(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = +y, month = +mo, day = +d;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Validate the actual calendar date (catches Feb 30, Apr 31, etc.).
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${y}-${mo}-${d}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
