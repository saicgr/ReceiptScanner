/** Barrel for the data layer. Import DB access from '@/db'. */
export * from './database';
export * from './settings';
export * as Receipts from './receipts';
export * as Categories from './categories';
export * as PaymentMethods from './paymentMethods';
export * as Tags from './tags';
export * as Mileage from './mileage';
export * as Statements from './statements';
export * as CashExpenses from './cashExpenses';
export * as Folders from './folders';
export * as Revisions from './revisions';
export * as Budgets from './budgets';

// Named re-exports for the most common direct calls.
export {
  createReceipt,
  getReceipt,
  listReceipts,
  listReceiptsWithRelations,
  updateReceipt,
  replaceLineItems,
  recomputeTotals,
  setReceiptTags,
  setReceiptImages,
  deleteReceipt,
  deleteReceipts,
  findPotentialDuplicates,
  totalsByCurrency,
  spendByCategory,
  spendByMonth,
  spendByCompany,
  spendByPaymentMethod,
  spendByItem,
  spendBySubcategory,
  spendByDay,
  quickStats,
  countReceipts,
} from './receipts';
export {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getCategory,
  listTaxCategories,
  createTaxCategory,
  updateTaxCategory,
  deleteTaxCategory,
  getTaxCategory,
} from './categories';
export {
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
} from './paymentMethods';
export {
  listTags,
  createTag,
  updateTag,
  deleteTag,
  ensureTag,
} from './tags';
