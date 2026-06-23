# ReceiptSnap — Build Contracts (single source of truth)

This file pins the exact module APIs so independently-built files integrate. **Follow signatures exactly.** When in doubt, READ the referenced existing file. Path alias `@/` → `src/`. TypeScript strict mode; everything must typecheck.

## Tech baseline
- Expo SDK 52, expo-router v4 (file routes already exist in `app/`), React 18, RN 0.76, TypeScript strict.
- State: zustand stores in `src/store`. Theme via `useTheme()` from `@/theme`.
- UI: compose ONLY from `@/components/ui` (read `src/components/ui/index.tsx` for the full kit). Do not invent new style systems. Use `<Screen>`, `<Card>`, `<Button>`, `<TextField>`, `<Text>`, `<Row>`, `<SectionHeader>`, `<ListRow>`, `<Chip>`, `<SegmentedControl>`, `<Stepper>`, `<SelectSheet>`, `<ConfidenceBadge>`, `<Badge>`, `<EmptyState>`, `<IconButton>`, `<Icon>`, `<Divider>`, `<Spacer>`, `<LoadingOverlay>`.
- Navigation: `import { router, useLocalSearchParams } from 'expo-router'`. Push with `router.push('/review')`, params via `router.push({ pathname: '/receipt/[id]', params: { id } })`.
- Money: `formatMoney(amount, currency)` from `@/lib/money`. Dates: `formatDate(iso, fmt)`, `daysUntil`, `relativeDays`, `deadlineFrom` from `@/lib/dates`.

## Existing data layer (READ `src/db/index.ts`, `src/types/index.ts`)
- `import * as DB from '@/db'` OR named imports from `@/db`.
- Receipts: `DB.createReceipt(input)`, `DB.getReceipt(id)`, `DB.listReceipts(opts)`, `DB.listReceiptsWithRelations(opts)`, `DB.updateReceipt(id, patch)`, `DB.replaceLineItems(id, items)`, `DB.recomputeTotals(id)`, `DB.setReceiptTags(id, tagIds)`, `DB.setReceiptImages(id, uris)`, `DB.deleteReceipt(id)`, `DB.deleteReceipts(ids)`, `DB.findPotentialDuplicates(hash, vendor, total, date, excludeId?)`, `DB.totalsByCurrency(filter)`, `DB.spendByCategory(filter)`, `DB.spendByMonth(filter)`, `DB.countReceipts()`.
- `ListReceiptsOptions` = `{ status?, search?, startDate?, endDate?, categoryIds?, tagIds?, currency?, limit?, offset?, orderBy? }` (orderBy: 'date_desc'|'date_asc'|'created_desc'|'amount_desc').
- Categories: `DB.listCategories()`, `DB.createCategory(p)`, `DB.updateCategory(id,p)`, `DB.deleteCategory(id)`.
- Tax categories: `DB.listTaxCategories()`, `DB.createTaxCategory(p)`, `DB.updateTaxCategory(id,p)`, `DB.deleteTaxCategory(id)`, `DB.getTaxCategory(id)`.
- Payment methods: `DB.listPaymentMethods()`, `DB.createPaymentMethod(p)`, `DB.updatePaymentMethod(id,p)`, `DB.deletePaymentMethod(id)`.
- Tags: `DB.listTags()`, `DB.createTag(p)`, `DB.updateTag(id,p)`, `DB.deleteTag(id)`, `DB.ensureTag(name, kind?)`.
- Mileage: `DB.Mileage.listTrips()`, `.createTrip(p)`, `.updateTrip(id,p)`, `.deleteTrip(id)`, `.getTrip(id)`.
- Statements: `DB.Statements.createImport(filename, lines)`, `.listImports()`, `.listLines(importId)`, `.listAllLines()`, `.setLineMatch(lineId, receiptId, score)`, `.deleteImport(id)`.
- Cash expenses: `DB.CashExpenses.listCashExpenses()`, `.createCashExpense(p)`, `.updateCashExpense(id,p)`, `.deleteCashExpense(id)`.
- Settings: `getSetting(key)`, `setSetting(key,value)`, `updateSettings(patch)`, `getAllSettings()`, `incrementScanCount()` from `@/db/settings`.

## Stores (READ `src/store/*`)
- `useSettings()` → `{ settings: AppSettings, loaded, load(), update(patch), canScan(), scansRemaining() }`.
- `useLookups()` → `{ categories, taxCategories, paymentMethods, tags, loaded, refresh(), categoryById(id), taxCategoryById(id), paymentById(id), tagById(id) }`.
- `useDraft()` → review working copy. Key fields: `vendor,date,date_confidence,date_ambiguous,date_options,tax,manual_total,currency,category_id,payment_method_id,tax_category_id,is_deductible,deductible_percent,suggested_tax_category,memo,image_format,source,status,original_image_uri,field_confidence,return_window_days,warranty_period_days,lineItems:DraftLineItem[],imageUris:string[],tagIds:string[],duplicateOfId,duplicateScore`. Selectors `subtotal()`, `total()`. Actions: `startFromExtraction(extraction,{imageUris,originalImageUri,source,imageFormat})`, `startFromReceipt(r)`, `reset()`, `setField(k,v)`, `patch(p)`, `addLineItem(item?)`, `updateLineItem(id,patch)`, `deleteLineItem(id)`, `toggleIncluded(id)`, `chooseDate(iso)`, `setDuplicate(id,score)`. Helper `draftDeadlines(state)` exported from `@/store/draft`.

---

# BACKEND API CONTRACT (`server/`) — current truth

Thin Express proxy (`server/src/index.js`). Stateless except in-memory rate counters, the bounded extraction LRU cache, and the ephemeral pending queue. **No user receipts are persisted server-side** (the ONLY durable store is Supabase, used solely for Roadmap votes + feature requests). No CORS middleware (native clients + mail webhook only).

**Auth.** Every endpoint that costs money or exposes user data requires BOTH headers `X-Device-Id` + `X-Device-Token` (`requireDeviceAuth`), where `X-Device-Token = HMAC-SHA256(deviceId, DEVICE_TOKEN_SECRET)`. Verification is stateless. An invalid pair → `401`. Mint a token via `POST /device/register` (per-IP rate-limited). `/inbound-email` is gated by a separate shared secret, not device auth.

**Endpoints**
- `GET  /health` — liveness + `{ ok, service, model, geminiConfigured, time }`. No auth.
- `POST /device/register` `{ deviceId }` → `{ deviceToken }`. Per-IP daily cap (`REGISTER_PER_DAY_PER_IP`, default 10).
- `GET  /forwarding-address` (authed) → `{ token, address }` (`user-<token>@<FORWARDING_DOMAIN>`), token = `sha256(deviceId)[:10]`.
- `POST /extract` (authed) `{ ocrText, imageBase64, imageMimeType, preferredDateFormat, categoryHints }` → `ExtractionResult` + `_meta`. Validates first (bad body never burns a scan). **Order:** per-IP cap → **server cache check (hit returns `_meta.cached:true`, no budget spent)** → per-device scan cap → global daily cap. Refunds the device scan + global slot on Gemini 5xx/timeout. Caches successful results (bounded LRU, `server/src/extractCache.js`).
- `POST /detect-receipts` (authed) `{ imageBase64, imageMimeType }` → `{ count, regions[] }`. Billed like /extract (per-IP + per-device scan + global cap, refunds on 5xx/timeout). Optional "Refine with AI".
- `POST /summarize` (authed) `{ receipt }` → `{ summary }`. Billed Gemini call but NOT a "scan" (per-IP + global cap only; global refund on 5xx/timeout).
- `POST /inbound-email` (shared-secret) — JSON or multipart (SendGrid Parse). Runs each attachment/body through the same pipeline into the pending queue; caps 3 attachments/email; draws on the global daily cap and **refunds the global slot when a Gemini call fails (TASK 37)**. In production an unset `INBOUND_EMAIL_SECRET` returns `503`.
- `GET  /pending` (authed) → `{ token, items }`. `POST /pending/ack` (authed) `{ ids }` → `{ ok, removed }`.
- `GET  /roadmap` (authed) → `{ updatedAt, items:[{...curated, upvotes, voted}] }`. Reads degrade to 0 votes when Supabase is down.
- `POST /roadmap/:id/vote` (authed) → `{ id, voted, upvotes }`. Shipped items 400; storage down → 503.
- `POST /feature-requests` (authed) `{ title, description?, category? }` → `{ ok, id }`. Per-device daily cap (`FEATURE_REQUESTS_PER_DAY`, default 10).
- `GET  /limits` (authed) → `{ remainingToday, lifetimeRemaining }` (no consume).

**Rate limits / billing circuit breaker** (`server/src/rateLimit.js`): per-device `RATE_LIMIT_PER_DAY` (default 50/day) + `RATE_LIMIT_LIFETIME` soft cap (default 5000); per-IP backstops on register/extract; a service-wide `GLOBAL_DAILY_GEMINI_CAP` (default 2000) across ALL Gemini routes. All counter maps are bounded (LRU eviction) to cap memory.

**Env vars** (`server/src/config.js`): `PORT` (8787); `GEMINI_API_KEY` (required to actually extract), `GEMINI_MODEL` (gemini-3.1-flash-lite via env / default), `GEMINI_BASE_URL`; `DEVICE_TOKEN_SECRET` (**required in production — refuses to boot without it**); `RATE_LIMIT_PER_DAY`, `RATE_LIMIT_LIFETIME`, `REGISTER_PER_DAY_PER_IP`, `EXTRACT_PER_DAY_PER_IP`, `GLOBAL_DAILY_GEMINI_CAP`, `FEATURE_REQUESTS_PER_DAY`; `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (optional — roadmap/feature-request storage; degrade gracefully when unset); `INBOUND_EMAIL_SECRET`, `FORWARDING_DOMAIN` (inbox.receiptsnap.app), `PENDING_TTL_MS`.

---

# SERVICES TO BUILD (`src/services/*`) — exact signatures

### `src/services/ocr.ts`
On-device OCR. Use `@react-native-ml-kit/text-recognition` (TextRecognition.recognize(uri)); wrap in try/catch and return empty text on web/unavailable.
- `export async function runOcr(imageUri: string): Promise<OcrResult>` (OcrResult from `@/types`: `{ text, blocks }`).

### `src/services/extractClient.ts`
Calls backend `POST /extract`. Base URL from `appConfig.apiBaseUrl` (`@/lib/config`). **Device-token auth** (the bare `X-Device-Id` is no longer trusted by the server): the device registers ONCE via `POST /device/register` and then presents BOTH `X-Device-Id` (from `getDeviceId()` in `@/lib/device`) and `X-Device-Token` (= `HMAC-SHA256(deviceId, server secret)`, persisted in the settings DB under the internal `device_token` key) on every authed call. `authedFetch(url, init)` attaches these headers, transparently re-registers + retries ONCE on `401`, and is the wrapper every proxy call must use. Body `{ ocrText, imageBase64, imageMimeType, preferredDateFormat, categoryHints }`. Image read via `expo-file-system` `readAsStringAsync(uri,{encoding:'base64'})`. On ANY network failure / non-2xx, fall back to a local heuristic using OCR text (`localExtractFallback`).
- **Extraction cache (TASK 33):** before calling the proxy, an identical request (same image bytes + OCR text + mime + date format + category hints, via `extractCacheKey` in `@/lib/extractCacheKey`) short-circuits to a persisted client cache (`src/services/extractCache.ts`, AsyncStorage, bounded LRU + TTL) — no network, no scan budget. Only REAL proxy results are cached (never the offline fallback). The server also keeps a bounded in-memory LRU as defense-in-depth (`server/src/extractCache.js`): a hit returns the cached extraction with `_meta.cached:true` and does NOT consume the per-device or global Gemini budget.
- `export async function extractReceipt(args: { imageUri?: string; imageBase64?: string|null; ocrText?: string; imageMimeType?: string; categoryHints?: string[] }): Promise<ExtractionResult>`
- `export function localExtractFallback(ocrText: string): ExtractionResult` (best-effort; vendor=first line, find a total via regex, currency guess, low confidence, empty line_items). Use `disambiguate` from `@/lib/dates` for any date found.
- `export async function authedFetch(url, init?): Promise<Response>`, `getDeviceToken(forceRegister?)`, `getDeviceAuthHeaders(forceRegister?)`.
- Returns `ExtractionResult` (from `@/types`).

### `src/services/receiptService.ts`
Bridges the draft store + image saving + filename + dupes + notifications to the DB.
- `export async function persistDraft(opts?: { finalize?: boolean }): Promise<string>` — reads `useDraft.getState()`, computes filename via `buildFilename` (`@/lib/filename`) using the user's `filename_template` + `date_format` + image_format from settings, copies/saves the primary image to app documents dir with that filename (expo-file-system), computes content hash (`contentHash` from `@/lib/hash`), upserts the receipt (create if new id not in DB else update + replaceLineItems + setReceiptTags + setReceiptImages), sets `status` to 'finalized' when `finalize`, computes protection deadlines via `draftDeadlines`, schedules notifications via notificationsService, increments scan count (`incrementScanCount`) for NEW receipts only, returns receipt id.
- `export async function checkDuplicate(): Promise<{ id: string; score: number } | null>` — uses `findPotentialDuplicates` + `duplicateScore` (`@/lib/hash`) against current draft; returns best match with score>=0.75.
- `export async function batchRename(receiptIds: string[]): Promise<number>` — regenerate saved_filename for each receipt from the current template; returns count updated.
- `export async function deleteReceiptCascade(id: string): Promise<void>` — cancel its notifications then `DB.deleteReceipt`.

### `src/services/imagePipeline.ts`
Capture/import + crop/enhance + PDF + stitching. Use expo-image-picker, expo-image-manipulator, expo-document-picker, expo-file-system.
- `export async function pickFromGallery(opts?:{multiple?:boolean}): Promise<string[]>` (uris)
- `export async function enhanceImage(uri: string): Promise<string>` — resize (max 2000px) + modest contrast; return new uri. (ImageManipulator)
- `export async function autoCropHint(uri: string): Promise<string>` — placeholder that returns enhanceImage result (document edge detection requires native; keep API).
- `export async function importPdf(): Promise<{ uri: string; pageUris: string[]; pageCount: number; rasterized: boolean } | null>` — pick a PDF (DocumentPicker). True on-device rasterisation is NOT achievable with the managed tooling (no native pdf renderer / WebView / expo-gl; `expo-image-manipulator` can't decode PDFs), so `rasterized` is `false` and `pageUris` is the PDF uri as a single logical page. The REAL `pageCount` is parsed from the PDF bytes (`countPdfPages`). Extraction relies on the backend, which reads every PDF page server-side. See `rasterizePdf(uri)` and `countPdfPages(text)` (pure, unit-tested) — the single place to expand to per-page images if a native rasteriser is ever added (TASK 36, PARTIAL).
- `export async function stitchImages(uris: string[]): Promise<string>` — vertically combine multiple photos of ONE long receipt into a single tall image. Implement via a best-effort approach: if a real stitch isn't possible without native canvas, return the first uri and store all as page images (document the limitation in comments). Prefer using `expo-image-manipulator` to at least normalize widths.
- `export async function saveImageWithName(srcUri: string, filename: string): Promise<string>` — copy to `${FileSystem.documentDirectory}receipts/${filename}` (mkdir if needed), return new uri.
- `export const RECEIPTS_DIR: string`.

### `src/services/notificationsService.ts`
Local notifications (expo-notifications) for warranty/return.
- `export async function ensurePermissions(): Promise<boolean>`
- `export async function scheduleProtectionReminders(receipt: { id:string; vendor:string }, opts:{ returnDeadline?:string|null; warrantyDeadline?:string|null; itemName?:string; returnDaysBefore:number; warrantyDaysBefore:number }): Promise<string[]>` — schedule "Return window … closes in N days" (returnDaysBefore before returnDeadline) and "Warranty … expires in N days" (warrantyDaysBefore before warrantyDeadline); return scheduled notification ids. Store mapping receiptId→ids in AsyncStorage key `notif:<receiptId>`.
- `export async function cancelReceiptReminders(receiptId: string): Promise<void>`
- `export function configureNotificationHandler(): void` (set handler; call once).

### `src/services/exporters.ts`
Itemized exports. Build strings/HTML; write file with expo-file-system; share with expo-sharing.
- `export interface ExportRow` itemized: receipt fields + one row per line item incl memo, tags, category, payment, tax category, deductible.
- `export async function exportReceipts(format: AccountingFormat, filter: ExportFilter): Promise<string>` — returns the written file uri. Uses `DB.listReceiptsWithRelations(filter)`. CSV/Excel via `@/lib/csv` `toCsv`. PDF via `expo-print` printToFileAsync(html). QuickBooks CSV (3-column 3-line or standard), QuickBooks IIF, Xero (Date,Amount,Payee,Description,Reference,AccountCode), Wave CSV. Itemized = one row per line item; include memo + tags columns ALWAYS.
- `export async function shareFile(uri: string): Promise<void>` (expo-sharing).
- `export async function exportTaxReport(rows: TaxReportRow[], opts:{year:number; format:'csv'|'pdf'}): Promise<string>`.

### `src/services/backupService.ts`
Backup/restore the SQLite DB + images to the USER'S OWN Google Drive / OneDrive via OAuth (expo-auth-session). No app servers.
- `export async function backupNow(provider: CloudProvider): Promise<{ ok: boolean; fileId?: string; message: string }>` — zip not required; upload the sqlite file (`${FileSystem.documentDirectory}SQLite/receiptsnap.db`) via the provider REST API after OAuth. Implement OAuth with `expo-auth-session` using client ids from `appConfig.google` / `appConfig.microsoftClientId`. If client ids are placeholders, return `{ok:false, message:'Configure OAuth client id in app.json'}` gracefully.
- `export async function restoreFrom(provider: CloudProvider): Promise<{ ok: boolean; message: string }>`.
- Keep functions defensive; never throw uncaught. Document setup in comments.

### `src/services/mileageService.ts`
GPS trip logging (expo-location), fully on-device.
- `export async function startTracking(onUpdate:(miles:number)=>void): Promise<boolean>` — request permission, watchPositionAsync, accumulate haversine distance, call onUpdate. Stores an internal subscription.
- `export async function stopTracking(): Promise<{ distanceMiles:number; path:{lat:number;lng:number;t:number}[] }>`
- `export function haversineMiles(a:{lat:number;lng:number}, b:{lat:number;lng:number}): number` (pure, exported for tests).

### `src/services/billingService.ts`
One-time IAP unlock (use `react-native-iap`; product id `appConfig.iapProductId`). Gate behind purchase.
- `export async function getProducts(): Promise<{ id:string; price:string; title:string }[]>`
- `export async function purchaseUnlock(): Promise<{ ok:boolean; message:string }>` — on success set setting `is_unlocked=true` via `useSettings.getState().update({is_unlocked:true})`.
- `export async function restorePurchases(): Promise<{ ok:boolean; message:string }>`
- Wrap all react-native-iap calls in try/catch; on simulators return a clear message. Never crash.

### `src/services/emailIngestService.ts`
Poll backend `/pending` for email-forwarded receipts. All calls go through `authedFetch` (X-Device-Id + X-Device-Token); the server derives the forwarding token server-side from the authenticated device id, so NO `?token=`/`?deviceId=` query params are sent any more.
- `export async function fetchForwardingAddress(): Promise<{ token:string; address:string }>` — GET `${apiBase}/forwarding-address`; persist to settings (`forwarding_token`,`forwarding_address`).
- `export async function pollPending(): Promise<{ id:string; extraction:ExtractionResult; imageBase64:string|null; imageMimeType:string|null }[]>` — GET `/pending`.
- `export async function ackPending(ids:string[]): Promise<void>` — POST `/pending/ack` `{ ids }`.

### `src/services/protectionsService.ts`
Compute the Protections tab list from DB.
- `export async function listProtections(): Promise<ProtectionEntry[]>` — query receipts + line items with non-null return_deadline/warranty_deadline, build `ProtectionEntry[]` (`@/types`), compute `daysRemaining` via `daysUntil`, sort by soonest. Include both receipt-level and item-level protections.

### `src/services/taxReportService.ts`
- `export async function buildTaxReport(opts:{ startDate:string; endDate:string }): Promise<TaxReportRow[]>` — group finalized receipts + cash expenses by tax category; gross + deductible (gross*deductible_percent/100) per currency. `TaxReportRow` from `@/types`.

### `src/services/index.ts`
Barrel re-exporting all services.

---

# SCREENS TO BUILD (`src/screens/*Screen.tsx`) — default export a component

General rules: wrap in `<Screen scroll>`; use the UI kit; pull data in `useEffect`/`useFocusEffect`; keep everything editable; show currency via `formatMoney`; show dates via `formatDate(iso, settings.date_format)`. Use `router` to navigate. Handle empty/loading states with `<EmptyState>`/`<LoadingOverlay>`.

1. **HomeScreen** — Greeting + scans-remaining (from `useSettings`), big "Quick Scan" and "Multi Scan" buttons (→ `/scan?mode=quick`, `/multi-scan`), quick stats (count, this-month total), recent receipts (tap → `/receipt/[id]`), header gear → `/settings`. If `!settings.onboarding_complete` push `/onboarding` once. Show a small forwarding-address card (call `emailIngestService.fetchForwardingAddress`) and a "Check inbox" action that polls pending and routes each to review.
2. **ScanScreen** — Source chooser for a SINGLE receipt: Camera (expo-camera), Gallery (`imagePipeline.pickFromGallery`), PDF (`imagePipeline.importPdf`). After getting image(s): enhance, run `ocr.runOcr`, `extractClient.extractReceipt`, `useDraft.startFromExtraction`, check duplicate, then `router.replace('/review')`. Show `<LoadingOverlay>` during extraction. Gate on `useSettings().canScan()` → if not, `router.push('/paywall')`.
3. **ReviewScreen** — THE core screen. Every field editable: vendor (TextField + ConfidenceBadge), date (shows interpretations when `date_ambiguous` via Chips calling `chooseDate`; else a date field formatted with settings.date_format), currency, tax, total (read-only computed `total()` when lineItems exist, else editable `manual_total`), category/payment/tax-category via SelectSheet, memo, tags (multi SelectSheet + Chips), split-transaction per-item category. Line items: list with name/qty(Stepper)/price editable, include checkbox (`toggleIncluded`), delete (`deleteLineItem`), add (`addLineItem`); subtotal+total recalc live. V2: return_window_days, warranty_period_days fields + per-item serial number + product photo; tax deductible toggle + percent (prefill from suggested_tax_category by matching name in lookups). Duplicate warning banner when `duplicateOfId`. "View full original" → `/image-viewer`. Save → `receiptService.persistDraft({finalize:true})` then `router.dismissAll()`/back to home. 
4. **MultiScanScreen** — Two modes via SegmentedControl: (a) "Separate receipts" — capture/import several, each processed into its own pending receipt (list with status, tap to review each); (b) "Stitch one long receipt" — capture several photos, `imagePipeline.stitchImages`, then single extraction → review. Show captured thumbnails; "Process all".
5. **HistoryScreen** — Search bar (vendor/memo), filter chips (category, tag/job, date range) via SelectSheet, list receipts (`DB.listReceipts`) grouped or flat with vendor/date/total/category color dot/confidence; tap → `/receipt/[id]`. Multi-select mode for batch delete + batch rename (`receiptService.batchRename`). Export button → opens format SelectSheet → `exporters.exportReceipts(format, filter)` then `shareFile`. Pending (email/unfinalized) section at top.
6. **StatisticsScreen** — Per-currency totals (`DB.totalsByCurrency`), spend by category (`DB.spendByCategory`) as a simple horizontal bar list with category colors, monthly trend (`DB.spendByMonth`) as a minimal bar chart (use Views, no chart lib). Currency switcher when multiple. Link to Tax Report and Statement Matching.
7. **ProtectionsScreen** — `protectionsService.listProtections()`. Two sections: active Return windows, active Warranties, sorted soonest first; each row shows item/vendor, deadline (`relativeDays`), serial number if present, tap → receipt. Empty state explaining the feature.
8. **MileageScreen** — Trip list (`DB.Mileage.listTrips`) with distance, rate, amount, date. "Start GPS trip" / "Stop" (mileageService) with a live distance counter; "Add manual entry" (distance + rate from `settings.mileage_rate` + category + tax category + memo). Show total miles + total amount. Also a "Add cash expense" entry point (CashExpenses) so the record is complete.
9. **TaxReportScreen** — Pick tax year / date range; `taxReportService.buildTaxReport`; table of tax categories with gross + deductible + currency; totals; export CSV/PDF via `exporters.exportTaxReport`. Schedule-C style.
10. **StatementMatchScreen** — Import CSV (DocumentPicker → read text → `parseStatementCsv` from `@/lib/statementMatch` → `DB.Statements.createImport`), run `matchStatement` against receipts, show matched / unmatched charges (possible missing receipts) / unmatched receipts; let user confirm matches (`setLineMatch`).
11. **ReceiptDetailScreen** — Read `useLocalSearchParams().id`; load `DB.getReceipt`; show full summary, image thumbnail(s) → `/image-viewer`, line items, protections, tax info; actions: Edit (`startFromReceipt` → `/review`), Share original (expo-sharing on original_image_uri), Share image/open-in, Delete (`receiptService.deleteReceiptCascade`).
12. **ImageViewerScreen** — params `{ uri }` (or `uris` json + index). Full-screen pinch/pan (use react-native-gesture-handler + reanimated OR a simple ScrollView with maximumZoomScale). Buttons: Share (expo-sharing), Close. Black background.
13. **SettingsScreen** — Sections linking to: Categories, Payment Methods, Tags & Jobs, Tax Categories, Filename Template, Backup & Restore, About. Inline controls: date format (SegmentedControl/SelectSheet of common formats), default currency, image format (jpg/png SegmentedControl), mileage rate (TextField), notification lead days (return/warranty), forwarding address display + copy, unlock status / "Unlock" → `/paywall`, share-with-friends (expo-sharing a link). Persist via `useSettings().update`.
14. **CategoriesScreen / PaymentMethodsScreen / TagsScreen / TaxCategoriesScreen** — CRUD list editors using the matching DB calls + `useLookups().refresh()` after changes. Color picker (preset swatches) for categories/tags; deductible percent for tax categories; kind (tag/job/trip) for tags.
15. **FilenameTemplateScreen** — Edit `filename_template`. Show available tokens (`FILENAME_TOKENS` from `@/lib/filename`) as add/remove chips, live preview via `applyFilenameTemplate` with a sample receipt, validate with `validateTemplate`, image format jpg/png, and a "Batch-rename all existing receipts" button (`receiptService.batchRename` over all receipt ids).
16. **BackupScreen** — Google Drive / OneDrive backup + restore buttons (`backupService`), show last_backup_at, explain it's the user's own cloud.
17. **PaywallScreen** — One-time $9.99 unlock. Show benefits (unlimited scans, export, cloud backup), `billingService.getProducts/purchaseUnlock/restorePurchases`. No subscriptions/ads copy.
18. **OnboardingScreen** — 3–4 slides incl the V2 hint: warranty/return reminders + tax-deduction intelligence are the reasons to keep the app. "Get started" sets `onboarding_complete=true` and asks notification permission.
19. **AboutScreen** — App name/version, the competitor-beating feature list, privacy (offline-first, no server receipt storage), share-with-friends link, credits.

Every screen file must `export default function XScreen() {...}`. Keep imports to existing modules + the services above. Do not modify files outside your assigned path.
