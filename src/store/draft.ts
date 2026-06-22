/**
 * Review draft store — the editable working copy of a receipt on the Scan/Review
 * screen. EVERY field is editable here and nothing is auto-finalized. Deleting or
 * unticking a line item recalculates the subtotal/total in real time (the key
 * competitor gap). The draft is built either from a fresh ExtractionResult or by
 * loading an existing receipt for editing, and committed via persistDraft().
 */
import { create } from 'zustand';
import { newId } from '../lib/id';
import { sumIncluded, round2 } from '../lib/money';
import { deadlineFrom } from '../lib/dates';
import type {
  Confidence,
  ExtractionResult,
  FieldConfidence,
  ImageFormat,
  LineItem,
  ProtectionStatus,
  ReceiptCondition,
  ReceiptSource,
  ReceiptStatus,
  ReceiptWithRelations,
} from '../types';

export interface DraftLineItem {
  id: string;
  name: string;
  qty: number;
  price: number;
  included: boolean;
  category_id: string | null;
  return_window_days: number | null;
  warranty_period_days: number | null;
  serial_number: string | null;
  product_photo_uri: string | null;
  protection_status: ProtectionStatus;
}

export interface DraftState {
  active: boolean;
  id: string;
  // Core editable fields
  vendor: string;
  date: string | null;
  date_confidence: Confidence;
  date_ambiguous: boolean;
  date_options: string[];
  tax: number | null;
  /** Grand total used ONLY when there are no line items (else total is derived). */
  manual_total: number;
  currency: string;
  category_id: string | null;
  payment_method_id: string | null;
  memo: string;
  image_format: ImageFormat;
  source: ReceiptSource;
  status: ReceiptStatus;
  original_image_uri: string | null;
  field_confidence: FieldConfidence;
  // V2
  return_window_days: number | null;
  warranty_period_days: number | null;
  tax_category_id: string | null;
  is_deductible: boolean;
  deductible_percent: number;
  // suggestions carried from extractor for the user to confirm
  suggested_tax_category: string | null;
  suggested_category: string | null;
  // V3: condition attributes + capture (EXIF) metadata
  condition_tags: ReceiptCondition[];
  captured_at: string | null;
  captured_lat: number | null;
  captured_lng: number | null;

  lineItems: DraftLineItem[];
  imageUris: string[];
  tagIds: string[];

  duplicateOfId: string | null;
  duplicateScore: number;

  // ---- selectors ----
  subtotal: () => number;
  total: () => number;

  // ---- actions ----
  startFromExtraction: (
    extraction: ExtractionResult,
    opts: { imageUris: string[]; originalImageUri: string | null; source: ReceiptSource; imageFormat: ImageFormat },
  ) => void;
  startFromReceipt: (r: ReceiptWithRelations) => void;
  reset: () => void;
  setField: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void;
  patch: (p: Partial<DraftState>) => void;

  addLineItem: (item?: Partial<DraftLineItem>) => void;
  updateLineItem: (id: string, patch: Partial<DraftLineItem>) => void;
  deleteLineItem: (id: string) => void;
  toggleIncluded: (id: string) => void;

  chooseDate: (iso: string) => void;
  setDuplicate: (id: string | null, score: number) => void;
}

const BLANK_FC: FieldConfidence = { vendor: 'low', date: 'low', total: 'low', tax: 'low' };

const initial = (): Omit<DraftState,
  | 'subtotal' | 'total' | 'startFromExtraction' | 'startFromReceipt' | 'reset'
  | 'setField' | 'patch' | 'addLineItem' | 'updateLineItem' | 'deleteLineItem'
  | 'toggleIncluded' | 'chooseDate' | 'setDuplicate'> => ({
  active: false,
  id: '',
  vendor: '',
  date: null,
  date_confidence: 'low',
  date_ambiguous: false,
  date_options: [],
  tax: null,
  manual_total: 0,
  currency: 'USD',
  category_id: null,
  payment_method_id: null,
  memo: '',
  image_format: 'jpg',
  source: 'camera',
  status: 'pending',
  original_image_uri: null,
  field_confidence: BLANK_FC,
  return_window_days: null,
  warranty_period_days: null,
  tax_category_id: null,
  is_deductible: false,
  deductible_percent: 100,
  suggested_tax_category: null,
  suggested_category: null,
  condition_tags: [],
  captured_at: null,
  captured_lat: null,
  captured_lng: null,
  lineItems: [],
  imageUris: [],
  tagIds: [],
  duplicateOfId: null,
  duplicateScore: 0,
});

export const useDraft = create<DraftState>((set, get) => ({
  ...initial(),

  subtotal: () => sumIncluded(get().lineItems),

  total: () => {
    const s = get();
    // With line items, the total is ALWAYS derived (sum of included + tax) so
    // deleting/unticking recalculates instantly. Without items, use manual_total.
    if (s.lineItems.length > 0) {
      return round2(sumIncluded(s.lineItems) + (s.tax ?? 0));
    }
    return round2(s.manual_total);
  },

  startFromExtraction: (extraction, opts) => {
    const items: DraftLineItem[] = (extraction.line_items ?? []).map((li) => ({
      id: newId(),
      name: li.name ?? '',
      qty: li.qty ?? 1,
      price: li.price ?? 0,
      included: true,
      category_id: null,
      return_window_days: li.return_window_days ?? null,
      warranty_period_days: li.warranty_period_days ?? null,
      serial_number: null,
      product_photo_uri: null,
      protection_status: 'none',
    }));

    const hasItems = items.length > 0;
    set({
      ...initial(),
      active: true,
      id: newId(),
      vendor: extraction.vendor ?? '',
      date: extraction.date ?? null,
      date_confidence: extraction.date_confidence ?? 'low',
      date_ambiguous: extraction.date_ambiguous ?? false,
      date_options: extraction.date_options ?? (extraction.date ? [extraction.date] : []),
      tax: extraction.tax ?? null,
      currency: extraction.currency ?? 'USD',
      field_confidence: {
        vendor: extraction.field_confidence?.vendor ?? 'low',
        date: extraction.field_confidence?.date ?? extraction.date_confidence ?? 'low',
        total: extraction.field_confidence?.total ?? 'low',
        tax: extraction.field_confidence?.tax ?? 'low',
      },
      return_window_days: extraction.return_window_days ?? null,
      warranty_period_days: extraction.warranty_period_days ?? null,
      is_deductible: extraction.is_deductible ?? false,
      deductible_percent: extraction.deductible_percent ?? 100,
      suggested_tax_category: extraction.tax_category ?? null,
      suggested_category: extraction.category ?? null,
      condition_tags: extraction.condition ?? [],
      lineItems: items,
      imageUris: opts.imageUris,
      original_image_uri: opts.originalImageUri,
      source: opts.source,
      image_format: opts.imageFormat,
      // When there are no line items, seed manual_total with the extracted total.
      // When there ARE items, total is derived from items+tax (live recalculation).
      manual_total: hasItems ? 0 : extraction.total ?? 0,
    });
  },

  startFromReceipt: (r) => {
    set({
      ...initial(),
      active: true,
      id: r.id,
      vendor: r.vendor,
      date: r.date,
      date_confidence: r.date_confidence,
      date_ambiguous: r.date_ambiguous,
      date_options: r.date_options,
      tax: r.tax,
      currency: r.currency,
      category_id: r.category_id,
      payment_method_id: r.payment_method_id,
      memo: r.memo,
      image_format: r.image_format,
      source: r.source,
      status: r.status,
      original_image_uri: r.original_image_uri,
      field_confidence: r.field_confidence,
      return_window_days: r.return_window_days,
      warranty_period_days: r.warranty_period_days,
      tax_category_id: r.tax_category_id,
      is_deductible: r.is_deductible,
      deductible_percent: r.deductible_percent,
      condition_tags: r.condition_tags,
      captured_at: r.captured_at,
      captured_lat: r.captured_lat,
      captured_lng: r.captured_lng,
      lineItems: r.line_items.map((li) => ({
        id: li.id,
        name: li.name,
        qty: li.qty,
        price: li.price,
        included: li.included,
        category_id: li.category_id,
        return_window_days: li.return_window_days,
        warranty_period_days: li.warranty_period_days,
        serial_number: li.serial_number,
        product_photo_uri: li.product_photo_uri,
        protection_status: li.protection_status,
      })),
      imageUris: r.images.map((i) => i.uri),
      tagIds: r.tags.map((t) => t.id),
      manual_total: r.line_items.length ? 0 : r.total,
    });
  },

  reset: () => set({ ...initial() }),

  setField: (key, value) => set({ [key]: value } as any),
  patch: (p) => set(p as any),

  addLineItem: (item) =>
    set((s) => ({
      lineItems: [
        ...s.lineItems,
        {
          id: newId(),
          name: item?.name ?? '',
          qty: item?.qty ?? 1,
          price: item?.price ?? 0,
          included: item?.included ?? true,
          category_id: item?.category_id ?? null,
          return_window_days: item?.return_window_days ?? null,
          warranty_period_days: item?.warranty_period_days ?? null,
          serial_number: item?.serial_number ?? null,
          product_photo_uri: item?.product_photo_uri ?? null,
          protection_status: item?.protection_status ?? 'none',
        },
      ],
    })),

  updateLineItem: (id, patch) =>
    set((s) => ({
      lineItems: s.lineItems.map((li) => (li.id === id ? { ...li, ...patch } : li)),
    })),

  deleteLineItem: (id) =>
    set((s) => ({ lineItems: s.lineItems.filter((li) => li.id !== id) })),

  toggleIncluded: (id) =>
    set((s) => ({
      lineItems: s.lineItems.map((li) =>
        li.id === id ? { ...li, included: !li.included } : li,
      ),
    })),

  chooseDate: (iso) =>
    set({ date: iso, date_ambiguous: false, date_confidence: 'high' }),

  setDuplicate: (id, score) => set({ duplicateOfId: id, duplicateScore: score }),
}));

/** Compute receipt-level protection deadlines from the current draft. */
export function draftDeadlines(s: DraftState): {
  return_deadline: string | null;
  warranty_deadline: string | null;
  protection_status: ProtectionStatus;
} {
  const return_deadline = deadlineFrom(s.date, s.return_window_days);
  const warranty_deadline = deadlineFrom(s.date, s.warranty_period_days);
  let protection_status: ProtectionStatus = 'none';
  if (return_deadline) protection_status = 'return_active';
  else if (warranty_deadline) protection_status = 'warranty_active';
  return { return_deadline, warranty_deadline, protection_status };
}
