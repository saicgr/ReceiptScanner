/**
 * Category budget DAO (V5). A budget is a per-category MONTHLY cap stored in a
 * specific currency, so it is only ever compared against same-currency spend —
 * multi-currency totals are never mixed.
 *
 * Two read views power the UI:
 *  - `budgetStatuses`   : budget vs THIS month's actual spend, bucketed into the
 *                         green/amber/red traffic light for the Home gauges.
 *  - `budgetVsActual`   : a 12-month per-category series for the comparison view.
 *
 * Spend always counts only FINALIZED receipts (mirrors the Statistics aggregates)
 * so pending/unreviewed scans never distort a budget gauge.
 */
import { getDb } from './database';
import { mapCategoryBudget } from './mappers';
import { newId } from '../lib/id';
import { round2 } from '../lib/money';
import type {
  CategoryBudget,
  BudgetStatus,
  BudgetVsActual,
  BudgetMonthCell,
} from '../types';

const NOW = () => new Date().toISOString();

/** Spend ratios at/above these fractions of the budget flag amber / red. */
export const BUDGET_NEAR_RATIO = 0.8;
export const BUDGET_OVER_RATIO = 1.0;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listBudgets(): Promise<CategoryBudget[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>('SELECT * FROM category_budgets');
  return rows.map(mapCategoryBudget);
}

export async function getBudget(
  categoryId: string,
  currency: string,
): Promise<CategoryBudget | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM category_budgets WHERE category_id = ? AND currency = ?',
    [categoryId, currency],
  );
  return row ? mapCategoryBudget(row) : null;
}

/**
 * Create or update the budget for a category+currency. An `amount` of 0 (or less)
 * clears the budget so the category drops off the gauges instead of pinning a
 * meaningless zero cap.
 */
export async function setBudget(
  categoryId: string,
  amount: number,
  currency: string,
): Promise<void> {
  const db = await getDb();
  const safe = round2(amount);
  if (!Number.isFinite(safe) || safe <= 0) {
    await db.runAsync(
      'DELETE FROM category_budgets WHERE category_id = ? AND currency = ?',
      [categoryId, currency],
    );
    return;
  }
  const existing = await getBudget(categoryId, currency);
  if (existing) {
    await db.runAsync(
      'UPDATE category_budgets SET amount = ?, updated_at = ? WHERE id = ?',
      [safe, NOW(), existing.id],
    );
  } else {
    const now = NOW();
    await db.runAsync(
      `INSERT INTO category_budgets (id, category_id, amount, currency, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
      [newId(), categoryId, safe, currency, now, now],
    );
  }
}

export async function deleteBudget(
  categoryId: string,
  currency: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM category_budgets WHERE category_id = ? AND currency = ?',
    [categoryId, currency],
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function levelFor(ratio: number): BudgetStatus['level'] {
  if (ratio >= BUDGET_OVER_RATIO) return 'over';
  if (ratio >= BUDGET_NEAR_RATIO) return 'near';
  return 'under';
}

/**
 * Budget vs actual for a single month (default: the current month), for one
 * currency. Returns one entry per budgeted category that has a budget in that
 * currency, ordered by how close it is to its cap (most at-risk first).
 *
 * @param month   "YYYY-MM" — the calendar month to total spend within.
 * @param currency the budget/spend currency to compare in.
 */
export async function budgetStatuses(
  month: string,
  currency: string,
): Promise<BudgetStatus[]> {
  const db = await getDb();
  const start = `${month}-01`;
  const end = `${month}-31`; // string compare on YYYY-MM-DD; covers the month
  const rows = await db.getAllAsync<any>(
    `SELECT b.category_id AS categoryId,
            COALESCE(c.name, 'Uncategorized') AS categoryName,
            COALESCE(c.color, '#64748B') AS color,
            b.amount AS budget,
            b.currency AS currency,
            COALESCE((
              SELECT SUM(r.total) FROM receipts r
              WHERE r.category_id = b.category_id
                AND r.currency = b.currency
                AND r.status = 'finalized'
                AND r.date IS NOT NULL
                AND r.date >= ? AND r.date <= ?
            ), 0) AS spent
     FROM category_budgets b
     LEFT JOIN categories c ON c.id = b.category_id
     WHERE b.currency = ?
     ORDER BY (spent / b.amount) DESC, b.amount DESC`,
    [start, end, currency],
  );
  return rows.map((r) => {
    const budget = Number(r.budget ?? 0);
    const spent = round2(Number(r.spent ?? 0));
    const ratio = budget > 0 ? spent / budget : 0;
    return {
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      color: r.color,
      currency: r.currency,
      budget: round2(budget),
      spent,
      ratio,
      remaining: round2(budget - spent),
      level: levelFor(ratio),
    };
  });
}

/** All distinct currencies that have at least one budget defined. */
export async function budgetCurrencies(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ currency: string }>(
    'SELECT DISTINCT currency FROM category_budgets ORDER BY currency ASC',
  );
  return rows.map((r) => r.currency);
}

/**
 * Build the trailing-12-month "YYYY-MM" keys ending at (and including)
 * `endMonth` (default: the current month), oldest first.
 */
export function last12Months(endMonth?: string): string[] {
  const anchor = endMonth ?? new Date().toISOString().slice(0, 7);
  const [y, m] = anchor.split('-').map((n) => parseInt(n, 10));
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Per-category Budget-vs-Actual over the trailing 12 months for one currency.
 * Each category's `months` array is aligned to `last12Months(endMonth)`, so the
 * caller can render a fixed 12-column comparison. The flat (same every month)
 * `budget` is the category's current monthly cap.
 */
export async function budgetVsActual(
  currency: string,
  endMonth?: string,
): Promise<BudgetVsActual[]> {
  const db = await getDb();
  const months = last12Months(endMonth);
  const start = `${months[0]}-01`;
  const end = `${months[months.length - 1]}-31`;

  const budgets = await db.getAllAsync<any>(
    `SELECT b.category_id AS categoryId,
            COALESCE(c.name, 'Uncategorized') AS categoryName,
            COALESCE(c.color, '#64748B') AS color,
            b.amount AS budget
     FROM category_budgets b
     LEFT JOIN categories c ON c.id = b.category_id
     WHERE b.currency = ?
     ORDER BY categoryName ASC`,
    [currency],
  );
  if (!budgets.length) return [];

  // Per-category, per-month actuals across the window in one pass.
  const spendRows = await db.getAllAsync<any>(
    `SELECT r.category_id AS categoryId,
            substr(r.date, 1, 7) AS month,
            SUM(r.total) AS total
     FROM receipts r
     WHERE r.currency = ?
       AND r.status = 'finalized'
       AND r.date IS NOT NULL
       AND r.date >= ? AND r.date <= ?
     GROUP BY r.category_id, month`,
    [currency, start, end],
  );
  const spendMap = new Map<string, number>(); // `${categoryId}|${month}` -> total
  for (const row of spendRows) {
    spendMap.set(`${row.categoryId}|${row.month}`, Number(row.total ?? 0));
  }

  return budgets.map((b) => {
    const monthsOut: BudgetMonthCell[] = months.map((month) => ({
      month,
      spent: round2(spendMap.get(`${b.categoryId}|${month}`) ?? 0),
    }));
    return {
      categoryId: b.categoryId,
      categoryName: b.categoryName,
      color: b.color,
      currency,
      budget: round2(Number(b.budget ?? 0)),
      months: monthsOut,
    };
  });
}
