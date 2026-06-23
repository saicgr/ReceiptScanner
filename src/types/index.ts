/**
 * ReceiptSnap — central domain type system.
 *
 * Every module (DB layer, services, stores, screens) imports its contracts from
 * here so the shape of a Receipt, LineItem, etc. is defined in exactly one place.
 *
 * Conventions:
 *  - All persisted ids are TEXT uuids (generated with expo-crypto).
 *  - All timestamps are ISO-8601 strings in UTC (`new Date().toISOString()`).
 *  - All money is stored as a JS number in the receipt's own `currency`.
 *  - Booleans persist as INTEGER 0/1 in SQLite; the DAO layer maps them to/from
 *    real booleans, so the rest of the app only ever sees real booleans.
 */

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

/** Where a receipt originated. */
export type ReceiptSource = 'camera' | 'gallery' | 'pdf' | 'email' | 'manual';

/** Lifecycle of a receipt. Nothing is ever auto-finalized — the user finalizes. */
export type ReceiptStatus = 'pending' | 'finalized';

/** Image file format the user chooses to persist the scan as. */
export type ImageFormat = 'jpg' | 'png';

/** Confidence buckets returned by the extractor / shown in the UI. */
export type Confidence = 'high' | 'medium' | 'low';

/** Protection lifecycle for warranty/return tracking (V2). */
export type ProtectionStatus =
  | 'none'
  | 'return_active'
  | 'return_expired'
  | 'warranty_active'
  | 'warranty_expired';

/** Cloud backup providers (user's own storage only). */
export type CloudProvider = 'google_drive' | 'onedrive';

/** Accounting export targets (file formats only — no live integrations). */
export type AccountingFormat =
  | 'csv'
  | 'excel'
  | 'pdf'
  | 'html'
  | 'quickbooks_csv'
  | 'quickbooks_iif'
  | 'xero_csv'
  | 'wave_csv';

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export interface LineItem {
  id: string;
  receipt_id: string;
  name: string;
  qty: number;
  price: number; // unit price; line total = qty * price
  /** Whether this item counts toward the live-recalculated total. */
  included: boolean;
  /** Split-transaction support: an item may belong to its own category. */
  category_id: string | null;
  /** Display / persistence ordering. */
  sort_order: number;

  // ---- V2: per-item warranty & return tracking ----
  protection_status: ProtectionStatus;
  return_window_days: number | null;
  warranty_period_days: number | null;
  return_deadline: string | null; // ISO date
  warranty_deadline: string | null; // ISO date
  serial_number: string | null;
  product_photo_uri: string | null;
}

export interface Receipt {
  id: string;
  vendor: string;
  /** Canonical ISO date (YYYY-MM-DD) once disambiguated. */
  date: string | null;
  date_confidence: Confidence;
  /** True when the raw date string had >1 plausible interpretation. */
  date_ambiguous: boolean;
  /** Candidate ISO dates the user must choose between when ambiguous. */
  date_options: string[];

  total: number;
  tax: number | null;
  /** Sum of included line items; kept in sync by the DAO/store. */
  subtotal: number;
  currency: string; // ISO 4217, e.g. "USD"

  category_id: string | null;
  payment_method_id: string | null;
  memo: string;

  // Image / file handling — the full original is ALWAYS retained.
  original_image_uri: string | null;
  saved_filename: string | null;
  image_format: ImageFormat;

  source: ReceiptSource;
  status: ReceiptStatus;

  // Duplicate detection
  content_hash: string | null;
  duplicate_of: string | null;

  // Overall confidence summary for the review screen.
  field_confidence: FieldConfidence;

  // ---- V2: receipt-level warranty / return ----
  return_window_days: number | null;
  warranty_period_days: number | null;
  return_deadline: string | null;
  warranty_deadline: string | null;
  protection_status: ProtectionStatus;

  // ---- V2: tax intelligence ----
  tax_category_id: string | null;
  is_deductible: boolean;
  deductible_percent: number; // 0..100, defaults from the tax category

  // ---- V3: condition attributes + capture metadata ----
  /** e.g. ['folded','faded'] — detected by the model, user-editable. */
  condition_tags: ReceiptCondition[];
  /** EXIF capture time of the source photo (fallback date / sort signal). */
  captured_at: string | null;
  /** EXIF GPS of the source photo (where the receipt was photographed). */
  captured_lat: number | null;
  captured_lng: number | null;

  created_at: string;
  updated_at: string;
}

/** Per-field confidence so the review screen can flag what to double-check. */
export interface FieldConfidence {
  vendor: Confidence;
  date: Confidence;
  total: Confidence;
  tax: Confidence;
}

/** A receipt joined with its line items, tags and (for stitched) page images. */
export interface ReceiptWithRelations extends Receipt {
  line_items: LineItem[];
  tags: Tag[];
  images: ReceiptImage[];
}

/** Multi-page / stitched receipt page images, ordered. */
export interface ReceiptImage {
  id: string;
  receipt_id: string;
  uri: string;
  page_order: number;
}

// ---------------------------------------------------------------------------
// Organization entities
// ---------------------------------------------------------------------------

export interface Category {
  id: string;
  name: string;
  color: string; // hex
  icon: string; // icon key from theme/icons
  is_default: boolean;
  sort_order: number;
  /**
   * Optional second-level grouping: when set, this category is a SUBCATEGORY of
   * `parent_id`. Kept to a single level (a subcategory never has children of its
   * own) and orthogonal to folders/tax/payment.
   */
  parent_id: string | null;
}

/**
 * A per-category MONTHLY budget (V5). The `amount` is the cap the user expects
 * to spend in `category_id` each month, denominated in `currency` so it is only
 * ever compared against same-currency spend (multi-currency totals never mix).
 */
export interface CategoryBudget {
  id: string;
  category_id: string;
  amount: number;
  currency: string;
  created_at: string;
  updated_at: string;
}

/**
 * A budget joined with the current period's actual spend — what the Home gauges
 * and the Budget-vs-Actual view render. `level` buckets spend-vs-budget into the
 * green/amber/red traffic light.
 */
export interface BudgetStatus {
  categoryId: string;
  categoryName: string;
  color: string;
  currency: string;
  budget: number;
  spent: number;
  /** spent / budget, 0..(>1). 0 when budget is 0 to avoid divide-by-zero. */
  ratio: number;
  remaining: number; // budget - spent (may be negative when over)
  level: 'under' | 'near' | 'over';
}

/** One category's budget vs actual for a single month (12-month report). */
export interface BudgetMonthCell {
  month: string; // YYYY-MM
  spent: number;
}

/** Per-category 12-month Budget-vs-Actual series. */
export interface BudgetVsActual {
  categoryId: string;
  categoryName: string;
  color: string;
  currency: string;
  budget: number;
  months: BudgetMonthCell[];
}

/** Tax-deduction layer (V2). e.g. "Meals (50%)", "Home Office". */
export interface TaxCategory {
  id: string;
  name: string;
  /** Default deductible percentage applied to receipts in this category. */
  deductible_percent: number;
  /** Schedule C line reference, informational. */
  schedule_c_line: string | null;
  is_default: boolean;
}

export interface PaymentMethod {
  id: string;
  name: string;
  is_default: boolean;
  sort_order: number;
}

/** Tags group receipts by trip or job; used for filtering and export. */
export interface Tag {
  id: string;
  name: string;
  color: string;
  /** Marks a tag as representing a job/trip for the dedicated filters. */
  kind: 'tag' | 'job' | 'trip';
}

// ---------------------------------------------------------------------------
// Folders — a file-manager-style label layer (Client -> Project -> Trip)
// ---------------------------------------------------------------------------

/**
 * A nestable folder. Folders are a MANY-TO-MANY label over the single
 * underlying receipt (see receipt_folders): "add to folder" never copies the
 * record, so stats/totals/deductions can never double-count. Folders are
 * orthogonal to category/tax/payment metadata — purely an organization view.
 */
export interface Folder {
  id: string;
  name: string;
  /** Parent folder id for nesting; null at the top level. */
  parent_id: string | null;
  color: string; // hex
  icon: string; // Ionicons glyph key
  sort_order: number;
  created_at: string;
}

/** A folder decorated with the counts shown in the file browser. */
export interface FolderNode extends Folder {
  /** Number of direct child folders. */
  childCount: number;
  /** Number of receipts labelled directly into THIS folder (not descendants). */
  receiptCount: number;
}

// ---------------------------------------------------------------------------
// Versioning — immutable original + edit-change log (lightweight)
// ---------------------------------------------------------------------------

/** What a saved snapshot represents. `original` = the AI's first extraction. */
export type RevisionKind = 'original' | 'manual';

/** A point-in-time snapshot of a receipt + its line items (for revert). */
export interface ReceiptRevision {
  id: string;
  receipt_id: string;
  kind: RevisionKind;
  /** JSON-encoded { receipt: Partial<Receipt>, line_items: Partial<LineItem>[] }. */
  snapshot_json: string;
  created_at: string;
}

/** Decoded revision snapshot payload. */
export interface RevisionSnapshot {
  receipt: Partial<Receipt>;
  line_items: Partial<LineItem>[];
}

/** One field-level change recorded in the receipt's edit log. */
export interface AuditLogEntry {
  id: string;
  receipt_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Mileage
// ---------------------------------------------------------------------------

export interface MileageTrip {
  id: string;
  start_time: string;
  end_time: string | null;
  distance_miles: number;
  rate_per_mile: number;
  /** Computed deductible/reimbursable amount = distance * rate. */
  amount: number;
  category_id: string | null;
  tax_category_id: string | null;
  memo: string;
  /** True when manually entered rather than GPS-logged. */
  is_manual: boolean;
  /** JSON-encoded array of {lat,lng,t} GPS points for auto-logged trips. */
  path_json: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Statement matching
// ---------------------------------------------------------------------------

export interface StatementImport {
  id: string;
  filename: string;
  imported_at: string;
  line_count: number;
}

export interface StatementLine {
  id: string;
  import_id: string;
  date: string | null;
  amount: number;
  description: string;
  /** Receipt this statement line was auto/manually matched to, if any. */
  matched_receipt_id: string | null;
  /** 0..1 score from the matcher. */
  match_score: number;
}

export interface MatchResult {
  matched: { line: StatementLine; receipt: Receipt; score: number }[];
  unmatchedLines: StatementLine[]; // possible missing receipts
  unmatchedReceipts: Receipt[]; // scanned but not on statement
}

// ---------------------------------------------------------------------------
// Manual cash expenses (V2 — completes the record without a paper receipt)
// ---------------------------------------------------------------------------

export interface CashExpense {
  id: string;
  date: string;
  vendor: string;
  amount: number;
  currency: string;
  category_id: string | null;
  tax_category_id: string | null;
  payment_method_id: string | null;
  memo: string;
  is_deductible: boolean;
  deductible_percent: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Settings (key/value, typed accessor in db/settings.ts)
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** Filename template tokens, e.g. "{date}_{company}_{amount}". */
  filename_template: string;
  /** moment-like format the user prefers, e.g. "MM/DD/YYYY". */
  date_format: string;
  default_currency: string;
  image_format: ImageFormat;
  /** Show the Mileage tab/feature. Off hides it for users who don't drive for work. */
  mileage_enabled: boolean;
  mileage_rate: number;
  /** Unique inbound forwarding address token (local mirror of server value). */
  forwarding_token: string;
  forwarding_address: string;
  /** Monetization. */
  scan_count: number;
  free_scan_limit: number;
  is_unlocked: boolean;
  /** V2 onboarding. */
  onboarding_complete: boolean;
  warranty_tax_hint_seen: boolean;
  /** Notifications. */
  notify_return_days_before: number;
  notify_warranty_days_before: number;
  /** Cloud backup. */
  last_backup_at: string | null;
  backup_provider: CloudProvider | null;
  /** Competitor-parity extras. */
  auto_crop: boolean; // auto-crop/enhance captures (vs keep original)
  app_lock: boolean; // require biometric/PIN to open History & Statistics
}

export const DEFAULT_SETTINGS: AppSettings = {
  filename_template: '{date}_{company}_{amount}',
  date_format: 'MM/DD/YYYY',
  default_currency: 'USD',
  image_format: 'jpg',
  mileage_enabled: true, // shown by default; users can hide it in Settings
  mileage_rate: 0.67, // IRS standard business rate placeholder
  forwarding_token: '',
  forwarding_address: '',
  scan_count: 0,
  free_scan_limit: 25,
  is_unlocked: false,
  onboarding_complete: false,
  warranty_tax_hint_seen: false,
  notify_return_days_before: 3,
  notify_warranty_days_before: 30,
  last_backup_at: null,
  backup_provider: null,
  auto_crop: true,
  app_lock: false,
};

// ---------------------------------------------------------------------------
// Extraction pipeline (OCR -> /extract -> review)
// ---------------------------------------------------------------------------

/** Raw JSON contract returned by the backend `/extract` endpoint. */
export interface ExtractionResult {
  vendor: string;
  date: string | null;
  date_confidence: Confidence;
  date_ambiguous: boolean;
  date_options?: string[];
  total: number;
  tax: number | null;
  currency: string;
  line_items: ExtractedLineItem[];
  field_confidence?: Partial<FieldConfidence>;

  // ---- V2 fields (backward-compatible: absent for V1 responses) ----
  return_window_days?: number | null;
  warranty_period_days?: number | null;
  /** Suggested spending category name (matched to the user's category list). */
  category?: string | null;
  tax_category?: string | null;
  is_deductible?: boolean | null;
  deductible_percent?: number | null;
  /** Receipt-condition attributes the model detects from the image. */
  condition?: ReceiptCondition[];
}

/** Controlled vocabulary of physical/quality conditions of a scanned receipt. */
export type ReceiptCondition =
  | 'torn'
  | 'folded'
  | 'crumpled'
  | 'faded'
  | 'blurry'
  | 'partial'
  | 'long'
  | 'handwritten'
  | 'thermal'
  | 'digital';

export const RECEIPT_CONDITIONS: ReceiptCondition[] = [
  'torn', 'folded', 'crumpled', 'faded', 'blurry', 'partial', 'long', 'handwritten', 'thermal', 'digital',
];

/**
 * One detected receipt region inside a single photo (see `/detect-receipts`).
 *
 * Coordinates are NORMALIZED to the source image: `x`/`y` are the top-left
 * origin and `width`/`height` the size, each in the range 0..1. Keeping them
 * normalized means the client can crop the original full-resolution image
 * regardless of any downscaling that happened before detection.
 */
export interface DetectedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional short hint (e.g. a vendor guess) shown next to the crop preview. */
  label?: string | null;
}

/** Result of the multi-receipt detector: how many distinct receipts, and where. */
export interface DetectionResult {
  count: number;
  regions: DetectedRegion[];
}

/**
 * On-device quality assessment of a single (cropped) receipt image. Surfaced as
 * a "check this one" hint in the split review grid so users know which crops may
 * need a re-shoot — computed purely from on-device signals (no network).
 */
export interface CropQuality {
  /** False when the crop looks unreliable (blurry/glare/too small/little text). */
  ok: boolean;
  /** Human-readable reasons for a not-ok assessment (e.g. "very little text"). */
  reasons: string[];
}

/** EXIF / file metadata read from an imported or captured photo. */
export interface ImageMeta {
  uri: string;
  /** ISO datetime the photo was taken (EXIF DateTimeOriginal), if present. */
  capturedAt: string | null;
  /** GPS coordinates from EXIF, if present. */
  lat: number | null;
  lng: number | null;
  width: number | null;
  height: number | null;
}

export interface ExtractedLineItem {
  name: string;
  qty: number;
  price: number;
  return_window_days?: number | null;
  warranty_period_days?: number | null;
}

/** Result of on-device OCR before hitting the network. */
export interface OcrResult {
  text: string;
  blocks: { text: string; confidence?: number }[];
}

// ---------------------------------------------------------------------------
// Export / reporting
// ---------------------------------------------------------------------------

export interface ExportFilter {
  startDate?: string | null;
  endDate?: string | null;
  categoryIds?: string[];
  tagIds?: string[];
  currency?: string | null;
}

export interface CurrencyTotal {
  currency: string;
  total: number;
  count: number;
}

export interface CategorySpend {
  categoryId: string | null;
  categoryName: string;
  color: string;
  currency: string;
  total: number;
  count: number;
}

export interface MonthlySpend {
  month: string; // YYYY-MM
  currency: string;
  total: number;
}

/** Spend grouped by a single calendar day (daily-pattern chart). */
export interface DailySpend {
  date: string; // YYYY-MM-DD
  currency: string;
  total: number;
}

/** Generic "spend grouped by some label" row (company, payment method, item). */
export interface GroupedSpend {
  key: string | null;
  label: string;
  color: string;
  currency: string;
  total: number;
  count: number;
}

/** Headline stats for the Statistics screen (per currency). */
export interface QuickStats {
  currency: string;
  total: number;
  count: number;
  average: number;
  highest: { receiptId: string; vendor: string; total: number } | null;
  mostFrequentVendor: { vendor: string; count: number } | null;
}

export interface TaxReportRow {
  taxCategoryId: string | null;
  taxCategoryName: string;
  deductiblePercent: number;
  grossTotal: number;
  deductibleTotal: number;
  currency: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Protections view (V2)
// ---------------------------------------------------------------------------

export interface ProtectionEntry {
  kind: 'return' | 'warranty';
  receiptId: string;
  lineItemId: string | null;
  vendor: string;
  itemName: string; // receipt vendor or line item name
  deadline: string; // ISO date
  daysRemaining: number;
  status: ProtectionStatus;
  serialNumber: string | null;
  productPhotoUri: string | null;
}
