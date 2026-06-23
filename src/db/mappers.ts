/**
 * Row <-> domain object mappers. SQLite stores booleans as 0/1 and complex
 * fields as JSON strings; these functions translate raw rows into the clean
 * domain types the rest of the app consumes, and back again.
 */
import type {
  Category,
  Confidence,
  FieldConfidence,
  ImageFormat,
  LineItem,
  PaymentMethod,
  ProtectionStatus,
  Receipt,
  ReceiptImage,
  ReceiptSource,
  ReceiptStatus,
  Tag,
  TaxCategory,
  MileageTrip,
  StatementLine,
  StatementImport,
  CashExpense,
  CategoryBudget,
  Folder,
  ReceiptRevision,
  RevisionKind,
  AuditLogEntry,
  Rebate,
  RebateStatus,
  PriceProtection,
  RecallRecord,
} from '../types';
import { toBool } from './database';

const DEFAULT_FC: FieldConfidence = {
  vendor: 'low',
  date: 'low',
  total: 'low',
  tax: 'low',
};

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function mapReceipt(r: any): Receipt {
  return {
    id: r.id,
    vendor: r.vendor ?? '',
    date: r.date ?? null,
    date_confidence: (r.date_confidence ?? 'low') as Confidence,
    date_ambiguous: toBool(r.date_ambiguous),
    date_options: parseJson<string[]>(r.date_options, []),
    total: Number(r.total ?? 0),
    tax: r.tax === null || r.tax === undefined ? null : Number(r.tax),
    subtotal: Number(r.subtotal ?? 0),
    currency: r.currency ?? 'USD',
    category_id: r.category_id ?? null,
    payment_method_id: r.payment_method_id ?? null,
    memo: r.memo ?? '',
    original_image_uri: r.original_image_uri ?? null,
    saved_filename: r.saved_filename ?? null,
    image_format: (r.image_format ?? 'jpg') as ImageFormat,
    source: (r.source ?? 'camera') as ReceiptSource,
    status: (r.status ?? 'pending') as ReceiptStatus,
    content_hash: r.content_hash ?? null,
    duplicate_of: r.duplicate_of ?? null,
    field_confidence: parseJson<FieldConfidence>(r.field_confidence, DEFAULT_FC),
    return_window_days:
      r.return_window_days === null || r.return_window_days === undefined
        ? null
        : Number(r.return_window_days),
    warranty_period_days:
      r.warranty_period_days === null || r.warranty_period_days === undefined
        ? null
        : Number(r.warranty_period_days),
    return_deadline: r.return_deadline ?? null,
    warranty_deadline: r.warranty_deadline ?? null,
    protection_status: (r.protection_status ?? 'none') as ProtectionStatus,
    tax_category_id: r.tax_category_id ?? null,
    is_deductible: toBool(r.is_deductible),
    deductible_percent: Number(r.deductible_percent ?? 100),
    condition_tags: parseJson<Receipt['condition_tags']>(r.condition_tags, []),
    captured_at: r.captured_at ?? null,
    captured_lat:
      r.captured_lat === null || r.captured_lat === undefined ? null : Number(r.captured_lat),
    captured_lng:
      r.captured_lng === null || r.captured_lng === undefined ? null : Number(r.captured_lng),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function mapLineItem(r: any): LineItem {
  return {
    id: r.id,
    receipt_id: r.receipt_id,
    name: r.name ?? '',
    qty: Number(r.qty ?? 1),
    price: Number(r.price ?? 0),
    included: toBool(r.included),
    category_id: r.category_id ?? null,
    sort_order: Number(r.sort_order ?? 0),
    protection_status: (r.protection_status ?? 'none') as ProtectionStatus,
    return_window_days:
      r.return_window_days === null || r.return_window_days === undefined
        ? null
        : Number(r.return_window_days),
    warranty_period_days:
      r.warranty_period_days === null || r.warranty_period_days === undefined
        ? null
        : Number(r.warranty_period_days),
    return_deadline: r.return_deadline ?? null,
    warranty_deadline: r.warranty_deadline ?? null,
    serial_number: r.serial_number ?? null,
    product_photo_uri: r.product_photo_uri ?? null,
  };
}

export function mapCategory(r: any): Category {
  return {
    id: r.id,
    name: r.name,
    color: r.color ?? '#0E7C66',
    icon: r.icon ?? 'tag',
    is_default: toBool(r.is_default),
    sort_order: Number(r.sort_order ?? 0),
    parent_id: r.parent_id ?? null,
  };
}

export function mapTaxCategory(r: any): TaxCategory {
  return {
    id: r.id,
    name: r.name,
    deductible_percent: Number(r.deductible_percent ?? 100),
    schedule_c_line: r.schedule_c_line ?? null,
    is_default: toBool(r.is_default),
  };
}

export function mapPaymentMethod(r: any): PaymentMethod {
  return {
    id: r.id,
    name: r.name,
    is_default: toBool(r.is_default),
    sort_order: Number(r.sort_order ?? 0),
  };
}

export function mapTag(r: any): Tag {
  return {
    id: r.id,
    name: r.name,
    color: r.color ?? '#64748B',
    kind: (r.kind ?? 'tag') as Tag['kind'],
  };
}

export function mapReceiptImage(r: any): ReceiptImage {
  return {
    id: r.id,
    receipt_id: r.receipt_id,
    uri: r.uri,
    page_order: Number(r.page_order ?? 0),
  };
}

export function mapMileageTrip(r: any): MileageTrip {
  return {
    id: r.id,
    start_time: r.start_time,
    end_time: r.end_time ?? null,
    distance_miles: Number(r.distance_miles ?? 0),
    rate_per_mile: Number(r.rate_per_mile ?? 0),
    amount: Number(r.amount ?? 0),
    category_id: r.category_id ?? null,
    tax_category_id: r.tax_category_id ?? null,
    memo: r.memo ?? '',
    is_manual: toBool(r.is_manual),
    path_json: r.path_json ?? null,
    created_at: r.created_at,
  };
}

export function mapStatementImport(r: any): StatementImport {
  return {
    id: r.id,
    filename: r.filename,
    imported_at: r.imported_at,
    line_count: Number(r.line_count ?? 0),
  };
}

export function mapStatementLine(r: any): StatementLine {
  return {
    id: r.id,
    import_id: r.import_id,
    date: r.date ?? null,
    amount: Number(r.amount ?? 0),
    description: r.description ?? '',
    matched_receipt_id: r.matched_receipt_id ?? null,
    match_score: Number(r.match_score ?? 0),
  };
}

export function mapFolder(r: any): Folder {
  return {
    id: r.id,
    name: r.name,
    parent_id: r.parent_id ?? null,
    color: r.color ?? '#0E7C66',
    icon: r.icon ?? 'folder',
    sort_order: Number(r.sort_order ?? 0),
    created_at: r.created_at,
  };
}

export function mapReceiptRevision(r: any): ReceiptRevision {
  return {
    id: r.id,
    receipt_id: r.receipt_id,
    kind: (r.kind ?? 'manual') as RevisionKind,
    snapshot_json: r.snapshot_json ?? '{}',
    created_at: r.created_at,
  };
}

export function mapAuditLogEntry(r: any): AuditLogEntry {
  return {
    id: r.id,
    receipt_id: r.receipt_id,
    field: r.field,
    old_value: r.old_value ?? null,
    new_value: r.new_value ?? null,
    created_at: r.created_at,
  };
}

export function mapCategoryBudget(r: any): CategoryBudget {
  return {
    id: r.id,
    category_id: r.category_id,
    amount: Number(r.amount ?? 0),
    currency: r.currency ?? 'USD',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function mapRebate(r: any): Rebate {
  return {
    id: r.id,
    receipt_id: r.receipt_id ?? null,
    vendor: r.vendor ?? '',
    description: r.description ?? '',
    amount: Number(r.amount ?? 0),
    currency: r.currency ?? 'USD',
    submission_deadline: r.submission_deadline ?? null,
    payout_deadline: r.payout_deadline ?? null,
    status: (r.status ?? 'pending') as RebateStatus,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function mapPriceProtection(r: any): PriceProtection {
  return {
    id: r.id,
    receipt_id: r.receipt_id ?? null,
    vendor: r.vendor ?? '',
    item_name: r.item_name ?? '',
    currency: r.currency ?? 'USD',
    original_price: Number(r.original_price ?? 0),
    current_price: Number(r.current_price ?? 0),
    claim_deadline: r.claim_deadline ?? null,
    status: (r.status ?? 'open') as PriceProtection['status'],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function mapRecallRecord(r: any): RecallRecord {
  return {
    recall_id: r.recall_id,
    title: r.title ?? '',
    recall_date: r.recall_date ?? null,
    url: r.url ?? '',
    hazard: r.hazard ?? '',
    product_text: r.product_text ?? '',
    cached_at: r.cached_at,
  };
}

export function mapCashExpense(r: any): CashExpense {
  return {
    id: r.id,
    date: r.date,
    vendor: r.vendor ?? '',
    amount: Number(r.amount ?? 0),
    currency: r.currency ?? 'USD',
    category_id: r.category_id ?? null,
    tax_category_id: r.tax_category_id ?? null,
    payment_method_id: r.payment_method_id ?? null,
    memo: r.memo ?? '',
    is_deductible: toBool(r.is_deductible),
    deductible_percent: Number(r.deductible_percent ?? 100),
    created_at: r.created_at,
  };
}
