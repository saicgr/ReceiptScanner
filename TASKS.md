# ReceiptSnap — Tasks

Status: ✅ Done · 🟡 Partial · ⬜ Todo

> Build-out (batches A–H) landed on branch `workflow/tasks-buildout`. tsc 0 errors · jest 243/243.

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Currency always renders a real symbol (no `"not found"` bug) | ✅ | `money.ts`; screens never interpolate `{currency}{amount}` |
| 2 | No garbage extraction for non-receipts | ✅ | Low-confidence editable state; nothing auto-finalized |
| 3 | Exports itemized, never totals-only | ✅ | `exporters.ts` — one row per line item |
| 5 | Split transactions (per-item categories) | ✅ | `split-review.tsx`, `LineItem.category_id` |
| 6 | Customizable categories | ✅ | `settings/categories.tsx` |
| 7 | Payment methods (cash, bank, credit, gift, PayPal, +add) | ✅ | Seeded in `seed.ts`, extendable |
| 8 | Save JPG/PNG + easy named export format | ✅ | Filename templates + batch rename |
| 9 | Auto-crop + enhance on device | ✅ | `imagePipeline.ts` |
| 10 | Advanced image enhance (de-skew, denoise, contrast) | 🟡 | **Batch E**: genuine de-skew shipped. Per-pixel filters (denoise/contrast/threshold) not possible with `expo-image-manipulator` (geometry-only) — needs a native module, deliberately not bundled |
| 11 | Memo/description column in every export | ✅ | Always present in `exporters.ts` |
| 12 | Statistics reflect multiple currencies | ✅ | Per-currency aggregates + switcher |
| 13 | One-time purchase, no subscriptions/ads | ✅ | $9.99 unlock, 25 free scans |
| 15 | Data export always works | ✅ | CSV/Excel/PDF/HTML + QuickBooks/Xero/Wave |
| 16 | Report column picker (check/reorder, Single vs Group, header) | ✅ | **Batch G**: `ReportColumnsScreen` + `reportConfig.ts`, wired into exporters |
| 17 | Groups (first-class grouping entity) | ✅ | **Batch A**: satisfied by the folder entity |
| 18 | Family & Friends / shared-team invites | ⬜ | Not built (roadmap/feature-requests added, but not invites); design vs offline-first |
| 19 | AI-generated receipt summary | ✅ | **Batch G**: `/summarize` proxy route (text-only Gemini), opt-in/gated, local fallback |
| 22 | FAQ / Customer Support screen | 🟡 | About screen only |
| 23 | Warranty & return protections + reminders | ✅ | `ProtectionsScreen` |
| 24 | Tax-deduction intelligence + Schedule-C report | ✅ | `TaxReportScreen` |
| 25 | Mileage tracking (GPS + manual) | ✅ | Flows into stats/tax/exports |
| 26 | Filename templates + batch rename | ✅ | |
| 27 | Date disambiguation | ✅ | |
| 28 | Email-receipt forwarding ingestion | ✅ | |
| 29 | Accounting-software exports (QuickBooks/Xero/Wave) | ✅ | Locale-safe `toFixed(2)` |
| 30 | Statement matching (CSV) | ✅ | |
| 31 | Duplicate detection (content hash) | ✅ | |
| 32 | Server rate-limit/global-cap hardening | ✅ | HMAC device tokens, circuit breaker |
| 33 | Extraction caching by `contentHash` | ✅ | **Batch H**: client AsyncStorage LRU + server in-memory LRU; hits skip Gemini + budget |
| 34 | Update docs to current API contract | ✅ | **Batch H**: `AGENT_CONTRACTS.md` + `README.md` |
| 35 | Migrate receipts off OS-purgeable cache paths | ✅ | **Batch H**: one-time migration guarded by settings flag |
| 36 | On-device PDF rasterization | 🟡 | **Batch H**: page-count parsing only; true on-device raster not achievable in managed tooling — Gemini still reads all PDF pages |
| 37 | Refund global cap slot on inbound-email Gemini failure | ✅ | **Batch H**: `inboundEmail.js` calls `globalRefund()` on failure |
| 38 | Edge detection: auto-crop **and straighten/de-skew** | ✅ | **Batch E**: de-skew via text-centroid angle fit + rotate |
| 39 | Multi-page scan stitched together | ✅ | Stitch mode = paged multi-page receipt |
| 40 | On-device OCR (ML Kit), no internet | ✅ | `ocr.ts` |
| 41 | Auto-detect payment card/method from receipt | ✅ | **Batch E**: `paymentDetect.ts` (brand/last-4), pre-fills draft |
| 42 | Spending by category | ✅ | Statistics |
| 43 | Monthly spending trends | ✅ | Per-currency monthly |
| 44 | Daily spending patterns chart | ✅ | **Batch B**: `spendByDay` + daily bar chart |
| 45 | Budgets + budget-vs-actual + home-screen budget gauges | ✅ | **Batch B**: `category_budgets` (migration v5), Home gauges, 12-mo Budget-vs-Actual |
| 46 | Geolocation tagging (capture GPS per receipt) | ✅ | **Batch F**: EXIF GPS, else device location behind a privacy-default-off toggle |
| 47 | Interactive map of where receipt was purchased + Open Map | 🟡 | **Batch F**: location card + Open-in-Maps deep link (Apple/Google). No embedded interactive map (avoids `react-native-maps` native config) |
| 48 | Face ID / Touch ID lock | ✅ | `app_lock` / `appLock.ts` |
| 51 | Cloud OCR (Gemini) for higher accuracy | ✅ | `/extract` proxy → Gemini Flash-Lite |
| 52 | Voice interaction / hands-free entry & correction | 🟡 | **Batch G**: TTS prompts via `expo-speech`. Speech-to-text stubbed (no heavy native STT) |
| 53 | Item-list extraction (every purchased item) | ✅ | Line items |
| 54 | Gmail receipt import | 🟡 | Email-forwarding ingestion exists; direct Gmail OAuth import NOT built (deferred — out of this build-out) |
| 55 | Ad-free | ✅ | No ads, ever |
| 56 | Pick from photo library with auto-crop | ✅ | Gallery import |
| 57 | Autocomplete for payees/categories/accounts | ✅ | **Batch G**: vendor autocomplete (`autocomplete.ts` + `AutocompleteField`) |
| 58 | Sort & search receipt history | ✅ | History search/filter |
| 59 | Multi-language support | 🟡 | **Batch G**: i18n scaffolding (English catalog + `t()` + Language picker); non-EN catalogs are empty stubs |
| 60 | Works on iPhone and iPad | ✅ | Expo cross-platform |
| 61 | Subcategory (second level under category) | ✅ | **Batch A** |
| 62 | Named accounts / specific card tracking (e.g. "Mastercard ****0694") | ✅ | **Batch G**: `account_label` + `account_last4` (migration v7) |
| 63 | Visual charts — pie / bar / line (not just lists) | ✅ | **Batch B**: real pie/bar/line via `react-native-svg` |
| 64 | Spending breakdown By Account and By Subcategory | ✅ | **Batch A/B** |
| 65 | Spending trend chart over time | ✅ | **Batch B**: line chart |
| 66 | "Received via Email" badge on auto-imported receipts | ✅ | **Batch G**: badge on History + detail when `source === 'email'` |
| 67 | Editable receipt date via calendar picker | ✅ | Review/detail screens with date disambiguation |
| 68 | QR / barcode receipt scanner (read fiscal/e-receipt QR) | ✅ | **Batch D**: scanner routes data→import, URL→extract pipeline; EU fiscal stubs (RKSV/DSFinV-K) |
| 69 | Share receipt via QR — cloud share-link (full receipt incl. image) | ✅ | **Batch D**: encodes Drive/OneDrive link; backup-gated; we host nothing |
| 70 | Share receipt via QR — compact data-only (offline app-to-app import) | ✅ | **Batch D**: pure-JS QR encoder (no new deps), oversize→file fallback |
| — | **POSITIONING / DIFFERENTIATION** | | _Strategy, not features — how we stand apart from commodity scanners_ |
| 71 | Lead with "Buy once, yours forever" — anti-subscription wedge | ⬜ | Hero line in App Store listing/ASO |
| 72 | Market privacy/offline — "your receipts never touch our servers" | ⬜ | Provable, hard for cloud-SaaS incumbents to copy |
| 73 | Reframe product as a "money-back / protection" app, not a "scanner" | ⬜ | Scanning is commodity; outcomes are the story |
| 74 | Target persona: self-employed / freelancer / small-biz owner | ⬜ | The underserved niche research points to |
| 75 | Make warranty/return reminders the hero feature | 🟡 | Feature exists (row 23); not yet positioned as the lead |
| 76 | Own tax season: one-tap accountant-ready Schedule-C export | 🟡 | Feature exists (row 24); push at download-peak tax time |
| — | **"MONEY-BACK / PROTECTION" FEATURES** (Batch C) | | _On-device, reuse existing schema/reminder infra_ |
| 77 | Credit-card purchase/return/warranty-protection surfacing | ✅ | **Batch C**: `cardBenefits.ts` static rules per payment method |
| 78 | Product recall alerts (CPSC recall feed) | ✅ | **Batch C**: on-demand fetch + cache + match + notify, offline-safe |
| 79 | Price-drop / price-protection claim reminders | ✅ | **Batch C**: `price_protections` + claim-window reminder |
| 80 | Warranty-claim assistant (serial + product photo + receipt) | ✅ | **Batch C**: shareable claim packet |
| 81 | Mail-in rebate tracking (submission + payout reminders) | ✅ | **Batch C**: `rebates` table + reminders |
| 82 | Recurring/subscription-charge flagging from statement import | ✅ | **Batch C**: `recurringCharges.ts` |
| 83 | Duplicate/overcharge detection from statement matching | ✅ | **Batch C**: `overcharge.ts` |
| 84 | Audit-proof retention vault (IRS-ready export) | ✅ | **Batch C**: audit-defense export (images + itemized) |
| 85 | "Missing receipt / missing deduction" nudges | ✅ | **Batch C**: `statementInsights.ts` |
| — | **RECEIPT MANAGEMENT** (Batch A) | | _Organization / sharing / versioning_ |
| 86 | File-manager-style folders (hierarchy + move/rename/delete/multi-select) | ✅ | **Batch A**: nested folders, breadcrumb nav |
| 86a | Folder "copy" semantics — avoid double-counting money | ✅ | **Batch A**: many-to-many ("add to folder"), one underlying receipt |
| 86b | Keep folders orthogonal to categories/tags/tax buckets | ✅ | **Batch A** |
| 86c | Navbar placement — fold into the Receipts tab, no 7th tab | ✅ | **Batch A**: folder nav in the existing receipts/History tab |
| 87 | Folder sharing — point-in-time (export bundle / own-cloud link) | ✅ | **Batch A**: `folderExport.ts` |
| 89 | Receipt versioning — lightweight (immutable original + revert + edit log) | ✅ | **Batch A**: `revisions.ts` |
