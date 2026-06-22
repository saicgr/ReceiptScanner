/**
 * Cached lookup lists (categories, tax categories, payment methods, tags) shared
 * across screens. Any screen that edits these calls refresh() afterward.
 */
import { create } from 'zustand';
import type { Category, PaymentMethod, Tag, TaxCategory } from '../types';
import { listCategories, listTaxCategories } from '../db/categories';
import { listPaymentMethods } from '../db/paymentMethods';
import { listTags } from '../db/tags';

interface LookupsState {
  categories: Category[];
  taxCategories: TaxCategory[];
  paymentMethods: PaymentMethod[];
  tags: Tag[];
  loaded: boolean;
  refresh: () => Promise<void>;
  categoryById: (id: string | null) => Category | undefined;
  taxCategoryById: (id: string | null) => TaxCategory | undefined;
  paymentById: (id: string | null) => PaymentMethod | undefined;
  tagById: (id: string | null) => Tag | undefined;
}

export const useLookups = create<LookupsState>((set, get) => ({
  categories: [],
  taxCategories: [],
  paymentMethods: [],
  tags: [],
  loaded: false,

  refresh: async () => {
    const [categories, taxCategories, paymentMethods, tags] = await Promise.all([
      listCategories(),
      listTaxCategories(),
      listPaymentMethods(),
      listTags(),
    ]);
    set({ categories, taxCategories, paymentMethods, tags, loaded: true });
  },

  categoryById: (id) => get().categories.find((c) => c.id === id),
  taxCategoryById: (id) => get().taxCategories.find((c) => c.id === id),
  paymentById: (id) => get().paymentMethods.find((p) => p.id === id),
  tagById: (id) => get().tags.find((t) => t.id === id),
}));
