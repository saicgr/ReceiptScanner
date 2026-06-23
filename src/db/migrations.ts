/**
 * Versioned SQLite migrations.
 *
 * The runner in database.ts reads `PRAGMA user_version`, then applies every
 * migration whose index is >= the stored version, bumping the version after
 * each. This is how the V1 -> V2 schema evolution (warranty/return + tax) is
 * applied SAFELY to existing installs without losing data.
 *
 * RULES:
 *  - Never edit a migration that has shipped; append a new one.
 *  - Migration N runs to move the DB from version N to N+1.
 *  - Keep each migration idempotent-ish where cheap (IF NOT EXISTS).
 */
import type { SQLiteDatabase } from 'expo-sqlite';

export type Migration = (db: SQLiteDatabase) => Promise<void>;

// ---------------------------------------------------------------------------
// Migration 0 -> 1 : V1 core schema
// ---------------------------------------------------------------------------
const m0_initial: Migration = async (db) => {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#0E7C66',
      icon TEXT NOT NULL DEFAULT 'tag',
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payment_methods (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#64748B',
      kind TEXT NOT NULL DEFAULT 'tag'
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY NOT NULL,
      vendor TEXT NOT NULL DEFAULT '',
      date TEXT,
      date_confidence TEXT NOT NULL DEFAULT 'low',
      date_ambiguous INTEGER NOT NULL DEFAULT 0,
      date_options TEXT NOT NULL DEFAULT '[]',
      total REAL NOT NULL DEFAULT 0,
      tax REAL,
      subtotal REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      category_id TEXT,
      payment_method_id TEXT,
      memo TEXT NOT NULL DEFAULT '',
      original_image_uri TEXT,
      saved_filename TEXT,
      image_format TEXT NOT NULL DEFAULT 'jpg',
      source TEXT NOT NULL DEFAULT 'camera',
      status TEXT NOT NULL DEFAULT 'pending',
      content_hash TEXT,
      duplicate_of TEXT,
      field_confidence TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
      FOREIGN KEY (payment_method_id) REFERENCES payment_methods(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS line_items (
      id TEXT PRIMARY KEY NOT NULL,
      receipt_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      qty REAL NOT NULL DEFAULT 1,
      price REAL NOT NULL DEFAULT 0,
      included INTEGER NOT NULL DEFAULT 1,
      category_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS receipt_images (
      id TEXT PRIMARY KEY NOT NULL,
      receipt_id TEXT NOT NULL,
      uri TEXT NOT NULL,
      page_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS receipt_tags (
      receipt_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (receipt_id, tag_id),
      FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mileage_trips (
      id TEXT PRIMARY KEY NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      distance_miles REAL NOT NULL DEFAULT 0,
      rate_per_mile REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0,
      category_id TEXT,
      memo TEXT NOT NULL DEFAULT '',
      is_manual INTEGER NOT NULL DEFAULT 0,
      path_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS statement_imports (
      id TEXT PRIMARY KEY NOT NULL,
      filename TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      line_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS statement_lines (
      id TEXT PRIMARY KEY NOT NULL,
      import_id TEXT NOT NULL,
      date TEXT,
      amount REAL NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      matched_receipt_id TEXT,
      match_score REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (import_id) REFERENCES statement_imports(id) ON DELETE CASCADE,
      FOREIGN KEY (matched_receipt_id) REFERENCES receipts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(date);
    CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);
    CREATE INDEX IF NOT EXISTS idx_receipts_category ON receipts(category_id);
    CREATE INDEX IF NOT EXISTS idx_receipts_hash ON receipts(content_hash);
    CREATE INDEX IF NOT EXISTS idx_line_items_receipt ON line_items(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_receipt_images_receipt ON receipt_images(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_statement_lines_import ON statement_lines(import_id);
  `);
};

// ---------------------------------------------------------------------------
// Migration 1 -> 2 : V2 warranty/return + tax intelligence + cash expenses
// ---------------------------------------------------------------------------
const m1_v2: Migration = async (db) => {
  // Tax categories table.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS tax_categories (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      deductible_percent REAL NOT NULL DEFAULT 100,
      schedule_c_line TEXT,
      is_default INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS cash_expenses (
      id TEXT PRIMARY KEY NOT NULL,
      date TEXT NOT NULL,
      vendor TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      category_id TEXT,
      tax_category_id TEXT,
      payment_method_id TEXT,
      memo TEXT NOT NULL DEFAULT '',
      is_deductible INTEGER NOT NULL DEFAULT 0,
      deductible_percent REAL NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL
    );
  `);

  // Add the V2 columns to receipts. addColumn helper tolerates re-runs.
  await addColumn(db, 'receipts', 'return_window_days', 'INTEGER');
  await addColumn(db, 'receipts', 'warranty_period_days', 'INTEGER');
  await addColumn(db, 'receipts', 'return_deadline', 'TEXT');
  await addColumn(db, 'receipts', 'warranty_deadline', 'TEXT');
  await addColumn(db, 'receipts', 'protection_status', "TEXT NOT NULL DEFAULT 'none'");
  await addColumn(db, 'receipts', 'tax_category_id', 'TEXT');
  await addColumn(db, 'receipts', 'is_deductible', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'receipts', 'deductible_percent', 'REAL NOT NULL DEFAULT 100');

  // Add the V2 per-item columns to line_items.
  await addColumn(db, 'line_items', 'protection_status', "TEXT NOT NULL DEFAULT 'none'");
  await addColumn(db, 'line_items', 'return_window_days', 'INTEGER');
  await addColumn(db, 'line_items', 'warranty_period_days', 'INTEGER');
  await addColumn(db, 'line_items', 'return_deadline', 'TEXT');
  await addColumn(db, 'line_items', 'warranty_deadline', 'TEXT');
  await addColumn(db, 'line_items', 'serial_number', 'TEXT');
  await addColumn(db, 'line_items', 'product_photo_uri', 'TEXT');

  // Mileage gains a tax category link.
  await addColumn(db, 'mileage_trips', 'tax_category_id', 'TEXT');

  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_receipts_return_deadline ON receipts(return_deadline);
    CREATE INDEX IF NOT EXISTS idx_receipts_warranty_deadline ON receipts(warranty_deadline);
    CREATE INDEX IF NOT EXISTS idx_line_items_return_deadline ON line_items(return_deadline);
    CREATE INDEX IF NOT EXISTS idx_line_items_warranty_deadline ON line_items(warranty_deadline);
    CREATE INDEX IF NOT EXISTS idx_receipts_tax_category ON receipts(tax_category_id);
  `);
};

/** ALTER TABLE ADD COLUMN that silently ignores "duplicate column" errors. */
async function addColumn(
  db: SQLiteDatabase,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  try {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (!/duplicate column name/i.test(msg)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Migration 2 -> 3 : V3 condition attributes + capture (EXIF) metadata
// ---------------------------------------------------------------------------
const m2_v3: Migration = async (db) => {
  await addColumn(db, 'receipts', 'condition_tags', "TEXT NOT NULL DEFAULT '[]'");
  await addColumn(db, 'receipts', 'captured_at', 'TEXT');
  await addColumn(db, 'receipts', 'captured_lat', 'REAL');
  await addColumn(db, 'receipts', 'captured_lng', 'REAL');
};

// ---------------------------------------------------------------------------
// Migration 3 -> 4 : V4 file-manager folders + subcategories + versioning
//
// Folders are a MANY-TO-MANY label layer over the single underlying receipt
// (receipt_folders join table) so adding a receipt to a folder NEVER duplicates
// the record — stats/totals/deductions can therefore never double-count. They
// are orthogonal to category/tax/payment metadata (a separate entity). Nested
// folders are modelled by a self-referential parent_id (Client -> Project ->
// Trip). `categories.parent_id` adds an optional second level (subcategory) that
// is likewise orthogonal — a subcategory is just a category whose parent is set.
//
// Versioning: receipt_revisions keeps an immutable snapshot of the AI's original
// extraction (kind='original', captured once at create) plus optional manual
// snapshots, enabling revert-to-original. receipt_audit_log is a lightweight
// edit-change log (field-level before/after rows).
// ---------------------------------------------------------------------------
const m3_v4: Migration = async (db) => {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT,
      color TEXT NOT NULL DEFAULT '#0E7C66',
      icon TEXT NOT NULL DEFAULT 'folder',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
    );

    -- Many-to-many: one underlying receipt can be LABELLED into many folders.
    CREATE TABLE IF NOT EXISTS receipt_folders (
      receipt_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (receipt_id, folder_id),
      FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE,
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
    );

    -- Immutable point-in-time snapshots (kind='original' is never overwritten).
    CREATE TABLE IF NOT EXISTS receipt_revisions (
      id TEXT PRIMARY KEY NOT NULL,
      receipt_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'manual',
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE
    );

    -- Lightweight edit-change log (one row per changed field).
    CREATE TABLE IF NOT EXISTS receipt_audit_log (
      id TEXT PRIMARY KEY NOT NULL,
      receipt_id TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
    CREATE INDEX IF NOT EXISTS idx_receipt_folders_folder ON receipt_folders(folder_id);
    CREATE INDEX IF NOT EXISTS idx_receipt_folders_receipt ON receipt_folders(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_receipt_revisions_receipt ON receipt_revisions(receipt_id);
    CREATE INDEX IF NOT EXISTS idx_receipt_audit_receipt ON receipt_audit_log(receipt_id);
  `);

  // Subcategory: a category may point at a parent category (second level only).
  await addColumn(db, 'categories', 'parent_id', 'TEXT');
  await db.execAsync(
    'CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);',
  );
};

// ---------------------------------------------------------------------------
// Migration 4 -> 5 : V5 per-category monthly budgets
//
// One row per category holding a single monthly budget amount (the cap the user
// expects to spend in that category each month). Currency is stored alongside so
// a budget is always compared against same-currency spend — multi-currency
// totals are never mixed (the gauges/Budget-vs-Actual view filter by currency).
// A NULL category_id row would be ambiguous, so budgets are keyed strictly to a
// real category via a FK that cascades on category delete.
// ---------------------------------------------------------------------------
const m4_v5: Migration = async (db) => {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS category_budgets (
      id TEXT PRIMARY KEY NOT NULL,
      category_id TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (category_id, currency),
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_category_budgets_category ON category_budgets(category_id);
  `);
};

/** Ordered list. Index i migrates the schema from version i to i+1. */
export const MIGRATIONS: Migration[] = [m0_initial, m1_v2, m2_v3, m3_v4, m4_v5];

export const LATEST_VERSION = MIGRATIONS.length;
