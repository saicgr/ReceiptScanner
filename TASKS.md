# ReceiptSnap — Tasks

Status: ✅ Done · 🟡 Partial · ⬜ Todo

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
| 10 | Advanced AI image enhance (de-skew, denoise, contrast) | ⬜ | Catch-up to Ace Receipt; no enhance slider yet |
| 11 | Memo/description column in every export | ✅ | Always present in `exporters.ts` |
| 12 | Statistics reflect multiple currencies | ✅ | Per-currency aggregates + switcher |
| 13 | One-time purchase, no subscriptions/ads | ✅ | $9.99 unlock, 25 free scans |
| 15 | Data export always works | ✅ | CSV/Excel/PDF/HTML + QuickBooks/Xero/Wave |
| 16 | Report column picker (check/reorder, Single vs Group, header) | ⬜ | Easiest parity win; we export full set today |
| 17 | Groups (first-class grouping entity) | 🟡 | Tags (tag/job/trip) substitute |
| 18 | Family & Friends / shared-team invites | ⬜ | Needs design vs offline-first stance |
| 19 | AI-generated receipt summary | ⬜ | Opt-in/gated — adds Gemini cost |
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
| 33 | Extraction caching by `contentHash` | ⬜ | Re-scans re-pay Gemini — verify against current code |
| 34 | Update docs to current API contract | ⬜ | `AGENT_CONTRACTS.md`, root `README.md` |
| 35 | Migrate receipts off OS-purgeable cache paths | ⬜ | One-time `persistReceiptImages` re-run |
| 36 | On-device PDF rasterization | ⬜ | |
| 37 | Refund global cap slot on inbound-email Gemini failure | ⬜ | |
| 38 | Edge detection: auto-crop **and straighten/de-skew** | 🟡 | We auto-crop/enhance; de-skew is part of task 10 |
| 39 | Multi-page scan stitched together | ✅ | Stitch mode = paged multi-page receipt |
| 40 | On-device OCR (ML Kit), no internet | ✅ | `ocr.ts` |
| 41 | Auto-detect payment card/method from receipt | ⬜ | We have payment methods; no auto-detect of the card |
| 42 | Spending by category | ✅ | Statistics |
| 43 | Monthly spending trends | ✅ | Per-currency monthly |
| 44 | Daily spending patterns chart | ⬜ | Not built |
| 45 | Budgets + budget-vs-actual + home-screen budget gauges | ⬜ | Confirmed in screenshots: per-category editable budgets, colored gauges on Home, Budget-vs-Actual 12-mo chart. No budgeting at all in our app |
| 46 | Geolocation tagging (capture GPS per receipt) | 🟡 | Confirmed: AceMoney has a "Record Geolocation" toggle + stored Lat/Lng. We store EXIF `captured_lat/lng`; not auto-tagged on capture |
| 47 | Interactive map of where receipt was purchased + Open Map | ⬜ | Confirmed: embedded Google Map in receipt + "Open Map". No in-receipt map view for us |
| 48 | Face ID / Touch ID lock | ✅ | `app_lock` / `appLock.ts` |
| 51 | Cloud OCR (Gemini) for higher accuracy | ✅ | `/extract` proxy → Gemini Flash-Lite |
| 52 | Voice interaction / hands-free entry & correction | ⬜ | Confirmed: mic button on Edit Receipt screen. Not built for us |
| 53 | Item-list extraction (every purchased item) | ✅ | Line items |
| 54 | Gmail receipt import | 🟡 | We have email-forwarding ingestion, not direct Gmail OAuth import |
| 55 | Ad-free | ✅ | No ads, ever |
| 56 | Pick from photo library with auto-crop | ✅ | Gallery import |
| 57 | Autocomplete for payees/categories/accounts | ⬜ | Not built |
| 58 | Sort & search receipt history | ✅ | History search/filter |
| 59 | Multi-language support | ⬜ | English only (competitor has Language setting) |
| 60 | Works on iPhone and iPad | ✅ | Expo cross-platform |
| 61 | Subcategory (second level under category) | ⬜ | AceMoney has Category + Subcategory; we have single-level categories |
| 62 | Named accounts / specific card tracking (e.g. "Mastercard ****0694") | ⬜ | We have payment-method types only, not named accounts/last-4 |
| 63 | Visual charts — pie / bar / line (not just lists) | 🟡 | AceMoney renders pie, monthly-detail bar, trend & budget-vs-actual line charts. Verify what our Statistics actually renders |
| 64 | Spending breakdown By Account and By Subcategory | ⬜ | We have by-category/company/payment/item; no account/subcategory dimensions |
| 65 | Spending trend chart over time | ⬜ | AceMoney "Trend" tab; we have monthly lists, no trend line |
| 66 | "Received via Email" badge on auto-imported receipts | 🟡 | We ingest via email forwarding; no explicit source badge in receipt UI |
| 67 | Editable receipt date via calendar picker | ✅ | Review/detail screens with date disambiguation |
| 68 | QR / barcode receipt scanner (read fiscal/e-receipt QR for structured data) | ⬜ | Strategic hedge, EU-gated — not a US-launch must-have. QR is becoming the primary delivery channel for digital receipts as paper is phased out (FR 2023, AT QR Oct 2026, IT 2027–29, DE 2029; ECJ ruling pending). No universal schema — works per-region (RKSV AT, DSFinV-K DE, NFC-e BR/CL). MVP: detect QR → fetch URL e-receipt → same review pipeline. Build when targeting Europe; pair with email-forwarding ingestion |
| 69 | Share receipt via QR — cloud share-link (full receipt incl. image) | ⬜ | Encode a Drive/OneDrive share link as QR; recipient scans → opens. We host nothing (lives in user's own cloud). Requires receipt backed up first; use revocable links. Image can't fit in a QR — link only |
| 70 | Share receipt via QR — compact data-only (offline app-to-app import) | ⬜ | Encode fields (vendor/date/total/tax/currency/line items) as compact JSON into QR; another ReceiptSnap user scans → imports to their DB. Serverless, offline, private — beats competitor's server-based team sharing. ~2953-byte QR cap → small/medium receipts only; fall back to export file when too big. No image travels |
| — | **POSITIONING / DIFFERENTIATION** | | _Strategy, not features — how we stand apart from commodity scanners_ |
| 71 | Lead with "Buy once, yours forever" — anti-subscription wedge | ⬜ | Hero line in App Store listing/ASO. Our reviews say "subscriptions suck"; incumbents (Expensify/Dext/ReceiptSync) are all SaaS |
| 72 | Market privacy/offline — "your receipts never touch our servers" | ⬜ | Provable, hard for cloud-SaaS incumbents to copy. Reinforced by offline QR share (row 70) |
| 73 | Reframe product as a "money-back / protection" app, not a "scanner" | ⬜ | Scanning is commodity; outcomes (returns, warranties, deductions) are the story |
| 74 | Target persona: self-employed / freelancer / small-biz owner | ⬜ | Wants deductions + protection + no monthly bill — the underserved niche research points to |
| 75 | Make warranty/return reminders the hero feature | 🟡 | Feature exists (row 23); not yet positioned/marketed as the lead |
| 76 | Own tax season: one-tap accountant-ready Schedule-C export | 🟡 | Feature exists (row 24); push it at download-peak tax time |
| — | **"MONEY-BACK / PROTECTION" FEATURE CANDIDATES** | | _New ideas extending the protection persona (mostly on-device, reuse existing schema)_ |
| 77 | Credit-card purchase/return/warranty-protection surfacing (by payment method) | ⬜ | Many cards extend warranty / refund price drops / offer purchase protection — surface per receipt from the captured payment method |
| 78 | Product recall alerts (match purchases against CPSC recall feed) | ⬜ | Notify if a purchased product is recalled — pure safety/protection value; free gov data source |
| 79 | Price-drop / price-protection claim reminders | ⬜ | Remind user to claim a refund when a recently bought item drops in price within the card/retailer window |
| 80 | Warranty-claim assistant (bundle serial + product photo + receipt) | ⬜ | `serial_number` + `product_photo_uri` already in schema — one-tap claim packet |
| 81 | Mail-in rebate tracking (submission + payout deadline reminders) | ⬜ | Track rebates like warranties; reuse the reminder infra |
| 82 | Recurring/subscription-charge flagging from statement import | ⬜ | Surface forgotten recurring charges to cancel — money-back; extends statement matching |
| 83 | Duplicate/overcharge detection from statement matching | 🟡 | Statement match exists (row 30); extend to flag double charges / tip errors |
| 84 | Audit-proof retention vault (IRS-ready, multi-year retention + export) | 🟡 | We retain originals + itemized exports; package as "audit defense" |
| 85 | "Missing receipt / missing deduction" nudges from unmatched charges | 🟡 | Unmatched statement lines = possible lost deduction; already flagged, surface as money-saving prompt |
| — | **RECEIPT MANAGEMENT (organization / sharing / versioning)** | | _Power-organizer features for the freelancer/audit persona_ |
| 86 | File-manager-style folders (hierarchy + move / rename / delete / multi-select) | ⬜ | Full folder UX: nested folders (Client → Project → Trip), breadcrumb nav, bulk move/rename/delete. The familiar surface for organizing receipts |
| 86a | Folder "copy" semantics — avoid double-counting money | ⬜ | A duplicated receipt double-counts in stats/totals/deductions. Make folders MANY-TO-MANY ("add to folder" = extra label, one underlying receipt) instead of true copy; or flag explicit duplicates as excluded from totals |
| 86b | Keep folders orthogonal to categories/tags/tax buckets | ⬜ | Folders = browse/structure; category/tax/payment = stats & deduction metadata. Don't fuse — a receipt in "Client A/Trip" is still category=Meals, tax=50% |
| 86c | Navbar placement — fold into the Receipts tab, no 7th tab | ⬜ | Rename History → "Receipts"/"Files"; make folder nav the primary view with a chronological toggle. Keep tab bar ≤5 (Home/Receipts/Statistics/Mileage/Settings...) |
| 87 | Folder sharing — point-in-time (export bundle / own-cloud link) | ⬜ | Scoped filtered-export of a folder/project: images + CSV/PDF to share sheet, or shared Drive/OneDrive link. We host nothing, no ongoing cost, stays private |
| 89 | Receipt versioning — lightweight (immutable original + revert + edit log) | ⬜ | Keep AI's original extraction + original image immutable; allow revert-to-original + simple change log ("AI read $54.21 → you set $45.43"). On-device, no cost; reinforces audit vault (row 84). NOT full git-style versioning (over-engineering) |
