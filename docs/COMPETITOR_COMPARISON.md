# ReceiptSnap vs. "Receipt Scanner" — Feature & Review Audit

_Last updated: 2026-06-22. Compares **ReceiptSnap** (this repo) against the competitor
app **"Receipt Scanner" v1.0.0+76**, captured in the 19 screenshots under `competitor/`.
Cross-checked against the actual code, not just the spec._

Legend: ✅ done · ⚠️ partial / different approach · ❌ missing · 🏆 we beat them

---

## 0. TL;DR

- **Every competitor bug their users complained about is fixed in our code.** The
  signature `"not found25.28"` currency bug, garbage non-receipt extraction, and
  zero-line-item exports are all specifically guarded against.
- **All four "implement this and I'll buy" review demands are shipped** (split
  transactions, custom categories, payment methods, named JPG/PNG save).
- **Both follow-up review asks are shipped** (memo/description column in exports;
  multi-currency statistics).
- **We lead on:** warranty/return protections, tax-deduction intelligence, mileage,
  filename templates, date disambiguation, email forwarding, accounting-software
  exports, offline-first with the user's own cloud.
- **Real gaps vs. the competitor:** no drag-reorder **report column picker**, no
  **Groups**, no **Family & Friends / shared-team invites**, no **fiscal QR codes**,
  no **AI-generated summary**. None are core to the complaints; see §4.

---

## 1. Competitor's damning bugs — did we avoid them?

| Competitor bug (seen in screenshots) | Status | Where we handle it |
|---|---|---|
| `"not found25.28"` Total Spending & `"not found12.64"` Avg Receipt — formatter pastes the literal string "not found" where a currency symbol belongs | ✅ 🏆 | `src/lib/money.ts` `formatMoney`/`currencySymbol` always emit a real symbol; currency defaults to a valid ISO code. Screens use `formatMoney()`, never `{currency}{amount}` interpolation (verified in `StatisticsScreen.tsx`). |
| Receipt detail: `Receipt # not found`, `Currency: not found`, truncated `Payment Method: not` | ✅ | Fields are typed/defaulted; review screen renders real values or an editable empty state. |
| Non-receipt (laptop keyboard photo) extracted into an all-zero garbage receipt | ✅ 🏆 | Low-confidence path + editable "couldn't read this" state; nothing auto-finalized (`status: 'pending'`). |
| Exports that show only totals, no line items / no memo | ✅ 🏆 | `src/services/exporters.ts`: **every** export is itemized (one row per line item) and **always** carries memo + tags columns. |

---

## 2. The user reviews — point-by-point

### Review A — "Implement these and I will purchase"
| Demand | Status | Evidence |
|---|---|---|
| 1. Split transactions (groceries / clothing / home improvement in one receipt) | ✅ | `app/split-review.tsx` + `SplitReviewScreen.tsx`; `LineItem.category_id` lets each item carry its own category. |
| 2. Customizable categories (was missing in Settings) | ✅ | `app/settings/categories.tsx` + `CategoriesScreen.tsx`; user-defined, editable, color/icon. |
| 3. Payment methods incl. cash, bank, credit, gift card, PayPal (+ add more) | ✅ | Seeded in `src/db/seed.ts`: Cash, Bank Account, Credit Card, Debit Card, Gift Card, PayPal; user-extendable in `PaymentMethodsScreen.tsx`. |
| 4. Save scan as JPG/PNG + easy named export format | ✅ 🏆 | `ImageFormat` choice + fully user-configurable filename template (`src/lib/filename.ts`, `FilenameTemplateScreen.tsx`), default `{date}_{company}_{amount}`, with batch re-naming. |

### Review B — "Reasonably impressed… lacks enhanced image features… look at Ace Receipt's new AI imaging and do some catch-up"
| Ask | Status | Notes |
|---|---|---|
| Image enhancement / AI imaging | ⚠️ | We auto-crop + enhance on-device (`src/services/imagePipeline.ts`) and always keep the full original. On-device multi-receipt detect/crop/rotate/quality is built; "Refine with AI" is the only Gemini step. **Catch-up item:** no advanced de-skew/denoise/contrast-boost "AI enhance" slider yet — candidate for parity with Ace Receipt. |

### Review C — "Does exactly what I need… please add memo/description to exported file (only tags now)… statistics don't reflect multiple currencies… subscriptions suck"
| Ask | Status | Evidence |
|---|---|---|
| Memo/description column in exports | ✅ 🏆 | `exporters.ts` — memo is **always** an export column (the explicit competitor fix), alongside tags. |
| Statistics reflect multiple currencies | ✅ 🏆 | `StatisticsScreen.tsx` groups every aggregate per currency with a currency switcher; all amounts via `formatMoney`. `DB.totalsByCurrency`. |
| No subscriptions | ✅ | One-time $9.99 unlock, 25 free scans, no ads (matches spec + their own "subscriptions suck" sentiment). |

### Review D — "Insists on Google Play Store install; I use Aurora Store; can't even export my data — 1 star"
| Concern | Status | Notes |
|---|---|---|
| App refuses to run when not installed via Play Store | ✅ 🏆 (by omission) | We do **not** implement Play-Install/licensing checks. Unlock is via `expo-in-app-purchases`; export/backup gate on `is_unlocked`, never on install source. **Watch-out:** ensure store-integrity / licensing libraries are never added — that bug is what cost them the star. |
| Data export must work regardless | ✅ | CSV/Excel/PDF/HTML + QuickBooks/Xero/Wave exporters; local SQLite, user owns the data. |

---

## 3. Competitor features we match or beat

| Competitor feature (screenshots) | Ours | Status |
|---|---|---|
| Tabs: Home / Analysis / Statistics / History / Settings | Home / Scan-Review / History / Statistics / Mileage / Protections / Settings | ✅ 🏆 (more) |
| Quick Scan + "Receipt too long? Scan in sections" | Quick Scan + Multi Scan (separate receipts **and** stitch one long receipt) | ✅ 🏆 |
| Multi-Scan tips (long & grocery receipts) | Multi-scan with on-device detection grid | ✅ |
| Statistics: By Category / Company / Payment Method / Item / Quick Stats | All present, **per-currency** | ✅ 🏆 |
| History: search, filter (date ranges, custom), sort, tags, Export, Restore | Searchable history, filter by category/tag/job, export | ✅ |
| Settings → Auto Crop toggle | `auto_crop` setting | ✅ |
| Settings → Protect History & Statistics (PIN/biometric) | `app_lock` + `appLock.ts` | ✅ |
| Settings → Date Format | `date_format` setting + date disambiguation | ✅ 🏆 |
| Backup to Google Drive / OneDrive (Premium) | User's own Drive/OneDrive, WAL-safe + images | ✅ |
| Premium: one-time $9.99, unlimited, cloud backup, restore purchases | Same model, gated on `is_unlocked` | ✅ |
| Customize XLS/PDF reports (single vs group, reorderable columns, header) | Itemized exports incl. all columns, but **no column picker UI** | ⚠️ see §4 |
| Share with Friends | About / share link | ✅ |
| FAQ / Customer Support | About screen | ⚠️ partial |
| "On Wi-Fi only" processing toggle | Removed deliberately (was dead) | ❌ (by choice) |
| AI-Generated Summary | — | ❌ see §4 |
| Groups | Tags (tag/job/trip) cover grouping, but no "Groups" entity | ⚠️ |
| Family & Friends: Send Invite (Premium), Enter Invite Code, join shared team | — | ❌ see §4 |
| Fiscal QR codes (RKSV Austria, DSFinV-K Germany) | — | ❌ regional, low priority |

---

## 4. Gaps to consider (competitor has, we don't)

1. **Report column picker** — competitor lets users check/uncheck and drag-reorder
   export columns, with Single vs Group reports and a report-header field. We always
   export the full itemized set. _Closing this would be straightforward parity._
2. **Groups** — a first-class grouping entity separate from tags. Our tags
   (tag/job/trip) substitute, but it's a different mental model.
3. **Family & Friends / shared-team invites** — sharing premium access + joining a
   shared team. Conflicts somewhat with our offline-first, no-server-storage stance;
   needs a design decision before building.
4. **AI-generated receipt summary** — a one-line natural-language summary. Cheap to
   add but adds Gemini cost (see cost constraint); would need to be opt-in/gated.
5. **Advanced image enhancement** (Review B / "Ace Receipt catch-up") — de-skew,
   denoise, contrast boost beyond current auto-crop.
6. **Fiscal compliance QR scanning** — regional (AT/DE); likely out of scope.

---

## 5. Where ReceiptSnap clearly wins 🏆

Features the competitor has **no equivalent** for:

- **Warranty & return protections** with deadline reminders (`ProtectionsScreen`, notifications).
- **Tax-deduction intelligence** — tax categories, `deductible_percent`, Schedule-C report (`TaxReportScreen`).
- **Mileage tracking** — GPS + manual, configurable per-mile rate, flows into stats/tax/exports.
- **Fully user-configurable filename templates** + batch re-naming.
- **Date disambiguation** — flags ambiguous dates and makes the user pick (their app just guesses).
- **Email-receipt forwarding** ingestion (Expensify-style unique inbox address).
- **Accounting-software exports** — QuickBooks CSV/IIF, Xero, Wave (locale-safe `toFixed(2)`).
- **Statement matching** — CSV import, match by amount + date, flag unmatched.
- **Duplicate detection** via content hash.
- **True offline-first**, no server-side storage of user receipts; user's own cloud only.

---

## 6. Known backlog (our own, from the June 2026 review)

These are _our_ open items, not competitor gaps — tracked here for completeness:

- Server rate-limit/global-cap hardening shipped; **extraction caching by `contentHash`** still not done (re-scans re-pay Gemini).
- Docs (`AGENT_CONTRACTS.md`, root `README.md`) still describe the **old API contract**.
- Pre-existing receipts may reference OS-purgeable cache image paths (one-time migration needed).
- On-device PDF rasterization not implemented.
- Inbound-email Gemini failures don't refund the global cap slot; each email import consumes a free scan (product decision).
