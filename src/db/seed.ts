/**
 * First-run seed data: sensible default categories, payment methods and tax
 * categories so the app is usable immediately. Seeding is guarded by a settings
 * flag so it runs exactly once; the user can edit/delete everything afterward.
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { newId } from '../lib/id';

const DEFAULT_CATEGORIES: { name: string; color: string; icon: string }[] = [
  { name: 'Groceries', color: '#16A34A', icon: 'cart' },
  { name: 'Dining', color: '#F59E0B', icon: 'restaurant' },
  { name: 'Fuel', color: '#DC2626', icon: 'car' },
  { name: 'Office Supplies', color: '#2563EB', icon: 'briefcase' },
  { name: 'Travel', color: '#7C3AED', icon: 'airplane' },
  { name: 'Utilities', color: '#0891B2', icon: 'flash' },
  { name: 'Electronics', color: '#475569', icon: 'hardware-chip' },
  { name: 'Healthcare', color: '#DB2777', icon: 'medkit' },
  { name: 'Entertainment', color: '#EA580C', icon: 'film' },
  { name: 'Other', color: '#64748B', icon: 'ellipsis-horizontal' },
];

const DEFAULT_PAYMENT_METHODS = [
  'Cash',
  'Bank Account',
  'Credit Card',
  'Debit Card',
  'Gift Card',
  'PayPal',
];

// Tax categories with their typical IRS Schedule C treatment (informational).
const DEFAULT_TAX_CATEGORIES: {
  name: string;
  pct: number;
  line: string;
}[] = [
  { name: 'Meals (50%)', pct: 50, line: 'Sch C line 24b' },
  { name: 'Supplies', pct: 100, line: 'Sch C line 22' },
  { name: 'Home Office', pct: 100, line: 'Form 8829' },
  { name: 'Mileage / Vehicle', pct: 100, line: 'Sch C line 9' },
  { name: 'Travel', pct: 100, line: 'Sch C line 24a' },
  { name: 'Equipment', pct: 100, line: 'Sch C line 13' },
  { name: 'Advertising', pct: 100, line: 'Sch C line 8' },
  { name: 'Utilities', pct: 100, line: 'Sch C line 25' },
  { name: 'Not Deductible', pct: 0, line: '' },
];

export async function seedDefaults(db: SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    let order = 0;
    for (const c of DEFAULT_CATEGORIES) {
      await db.runAsync(
        `INSERT INTO categories (id, name, color, icon, is_default, sort_order)
         VALUES (?, ?, ?, ?, 1, ?)`,
        [newId(), c.name, c.color, c.icon, order++],
      );
    }

    order = 0;
    for (const p of DEFAULT_PAYMENT_METHODS) {
      await db.runAsync(
        `INSERT INTO payment_methods (id, name, is_default, sort_order)
         VALUES (?, ?, 1, ?)`,
        [newId(), p, order++],
      );
    }

    for (const t of DEFAULT_TAX_CATEGORIES) {
      await db.runAsync(
        `INSERT INTO tax_categories (id, name, deductible_percent, schedule_c_line, is_default)
         VALUES (?, ?, ?, ?, 1)`,
        [newId(), t.name, t.pct, t.line],
      );
    }
  });
}
