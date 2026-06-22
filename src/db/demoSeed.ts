/**
 * Demo data — a handful of realistic finalized receipts used to preview the UI
 * with content (History, Statistics, Home recents). This is NOT part of normal
 * seeding; it is invoked manually (e.g. a dev hook on web) and no-ops if the
 * user already has receipts, so it never overwrites real data.
 */
import { listCategories } from './categories';
import { listPaymentMethods } from './paymentMethods';
import { createReceipt, countReceipts } from './receipts';

interface DemoReceipt {
  vendor: string;
  day: number;
  monthsAgo?: number;
  category: string;
  payment: string;
  currency?: string;
  tax: number;
  date_confidence: 'high' | 'medium' | 'low';
  date_ambiguous?: boolean;
  memo?: string;
  items: { name: string; qty: number; price: number }[];
}

const DEMO: DemoReceipt[] = [
  { vendor: 'Whole Foods Market', day: 18, category: 'Groceries', payment: 'Credit Card', tax: 6.1, date_confidence: 'high',
    items: [ { name: 'Organic bananas', qty: 2, price: 1.7 }, { name: 'Almond milk', qty: 1, price: 4.99 }, { name: 'Sourdough loaf', qty: 1, price: 6.5 }, { name: 'Greek yogurt', qty: 3, price: 3.99 }, { name: 'Cold brew · 32oz', qty: 1, price: 51.24 } ] },
  { vendor: 'Apple Store', day: 15, category: 'Electronics', payment: 'Credit Card', tax: 99, date_confidence: 'high', memo: 'New work laptop',
    items: [ { name: 'MacBook Air M3', qty: 1, price: 1200 } ] },
  { vendor: 'Uber', day: 17, category: 'Travel', payment: 'Credit Card', tax: 0, date_confidence: 'medium', date_ambiguous: true, memo: 'Airport ride',
    items: [ { name: 'Trip · Downtown → SFO', qty: 1, price: 32.5 } ] },
  { vendor: 'Shell', day: 12, category: 'Fuel', payment: 'Debit Card', tax: 0, date_confidence: 'high',
    items: [ { name: 'Unleaded · 11.8 gal', qty: 1, price: 52.3 } ] },
  { vendor: 'Starbucks', day: 19, category: 'Dining', payment: 'Cash', tax: 1.1, date_confidence: 'high',
    items: [ { name: 'Flat white', qty: 1, price: 5.25 }, { name: 'Butter croissant', qty: 1, price: 4.4 }, { name: 'Cold brew', qty: 1, price: 4.0 } ] },
  { vendor: 'Delta Air Lines', day: 6, category: 'Travel', payment: 'Credit Card', tax: 38.4, date_confidence: 'high', memo: 'SFO → JFK',
    items: [ { name: 'Main Cabin fare', qty: 1, price: 381.6 } ] },
  { vendor: 'Office Depot', day: 9, category: 'Office Supplies', payment: 'Credit Card', tax: 5.1, date_confidence: 'medium',
    items: [ { name: 'Printer paper · 5 ream', qty: 1, price: 42.95 }, { name: 'Ballpoint pens · 12pk', qty: 1, price: 8.4 }, { name: 'Sticky notes', qty: 2, price: 3.5 } ] },
  { vendor: 'Le Petit Café', day: 4, category: 'Dining', payment: 'Cash', currency: 'EUR', tax: 0, date_confidence: 'medium', memo: 'Client lunch',
    items: [ { name: 'Croque monsieur', qty: 1, price: 14 }, { name: 'Espresso', qty: 2, price: 3.5 }, { name: 'Tarte tatin', qty: 1, price: 7 } ] },
];

function dateFor(day: number, monthsAgo = 0): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function seedDemoReceipts(): Promise<number> {
  if ((await countReceipts()) > 0) return 0;
  const cats = await listCategories();
  const pms = await listPaymentMethods();
  const catId = (name: string) => cats.find((c) => c.name === name)?.id ?? null;
  const pmId = (name: string) => pms.find((p) => p.name === name)?.id ?? null;

  let made = 0;
  for (const r of DEMO) {
    await createReceipt({
      vendor: r.vendor,
      date: dateFor(r.day, r.monthsAgo),
      date_confidence: r.date_confidence,
      date_ambiguous: r.date_ambiguous ?? false,
      currency: r.currency ?? 'USD',
      tax: r.tax,
      category_id: catId(r.category),
      payment_method_id: pmId(r.payment),
      memo: r.memo ?? '',
      status: 'finalized',
      source: 'gallery',
      field_confidence: {
        vendor: 'high',
        date: r.date_confidence,
        total: r.date_confidence === 'low' ? 'medium' : 'high',
        tax: 'high',
      },
      line_items: r.items.map((it) => ({ name: it.name, qty: it.qty, price: it.price, included: true })),
    });
    made++;
  }
  return made;
}
