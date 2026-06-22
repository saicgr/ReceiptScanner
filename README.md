# ReceiptSnap

**Scan, correct, and own your receipts — offline-first, one-time purchase, no subscriptions, no ads.**

ReceiptSnap is a cross-platform mobile receipt scanner built with **Expo (SDK 52) / React Native 0.76 / expo-router v4 / TypeScript (strict)**. It captures paper *and* digital receipts, runs on-device OCR, asks Gemini Flash-Lite to structure the data through a thin proxy you control, and then puts **every single field in your hands to edit** before anything is saved. Your receipts live in a local SQLite database on your device — they are never stored on our servers.

It also goes beyond "just scanning": ReceiptSnap tracks **return windows and warranties** with local reminders, suggests **tax categories and deductibility** for freelancers/SMBs, logs **mileage**, and exports **itemized** data in CSV/Excel/PDF and QuickBooks/Xero/Wave formats.

---

## Why ReceiptSnap beats the competition

ReceiptSnap was designed by going through real user complaints about a popular competitor and fixing **all** of them, then adding the features people actually stay for.

| The competitor's problem | How ReceiptSnap solves it |
| --- | --- |
| Poor accuracy with **no way to correct it** | Every extracted field (vendor, date, total, tax, currency, line items) is **fully editable** on the Review screen. Nothing is ever auto-finalized. A confidence badge flags fields worth double-checking. |
| **Ambiguous dates** silently guessed wrong | True **date disambiguation**: when a date like `25/12/05` is ambiguous, the app shows every plausible interpretation as tappable chips and **you pick**. Set a preferred date format in Settings to reduce ambiguity up front. |
| **Couldn't control the saved filename** | A user-configurable **filename template** (`FILENAME_TOKENS`), default `{date}_{company}_{amount}` and nothing else. Reorder/remove tokens, live preview, applies to every scan, and supports **batch rename** of existing receipts. |
| **Weak bulk scanning** | **Multi Scan** with two modes: (a) many separate receipts in one session, and (b) **stitch one long receipt** from several photos into a single combined receipt. |
| **Couldn't view the full original image** | The full original image is **always kept**. Open it full-screen (pinch/pan) any time, share it, or open it in another app. |
| **Couldn't delete line items** | Add, edit, or **delete** individual line items. Un-ticking or deleting an item **recalculates the total live**. |
| Exports that **only showed totals** | Exports are **itemized** — one row per line item — and always include the memo/description and tags. Filter exports by date range, category, and tag/job. |

### And the reasons people *keep* the app installed

- **Warranty & return tracking** — Gemini infers a sensible return window and warranty period per receipt/item; you confirm or edit them; local push notifications warn you *before* a return window closes or a warranty expires. A dedicated **Protections** tab lists active windows soonest-first. Attach a product photo and store serial numbers for claims.
- **Tax-deduction intelligence** — A tax-category layer (Meals 50%, Supplies, Home Office, Mileage, Travel, Equipment…). Gemini suggests a likely tax category and deductibility; you override. A **Tax Report** generator outputs a Schedule-C-style categorized summary (gross vs deductible, per currency) as CSV/PDF.
- **Email-receipt forwarding** — Each user gets a unique `user-xxxx@inbox.receiptsnap.app` address. Receipts emailed/forwarded there are auto-ingested through the same extraction pipeline and dropped into your pending list to review. Captures digital/e-receipts, not just paper.
- **Mileage tracking** — On-device GPS trip logging plus manual entry, with a configurable per-mile rate that flows into reports and categories. No per-use API cost.
- **Statement matching** — Import a bank/card statement as CSV and auto-match receipts by amount + date proximity; flag unmatched charges (possible missing receipts) and unmatched receipts. **CSV only — no live bank connections, no stored credentials.**
- **Backup to *your own* cloud** — Back up/restore the SQLite database to **your** Google Drive or OneDrive via OAuth. We never hold your data.

---

## Tech stack

**App (this repo root)**

- **Expo SDK 52**, **React Native 0.76**, **React 18.3**, New Architecture enabled
- **expo-router v4** file-based routing (`app/`), **typed routes**
- **TypeScript** in **strict** mode; `@/` path alias → `src/`
- **zustand** for state (`src/store/*`); custom theme via `useTheme()` (`@/theme`)
- A shared, opinionated **UI kit** in `src/components/ui` (compose only from it)
- **expo-sqlite** — local, offline-first database (`src/db`)
- On-device OCR: **`@react-native-ml-kit/text-recognition`** (requires a dev build — see below)
- Imaging: **expo-camera**, **expo-image-picker**, **expo-image-manipulator**, **expo-document-picker** (incl. multi-page PDFs)
- **expo-notifications** (warranty/return reminders), **expo-location** (mileage), **expo-print** + **expo-sharing** (exports), **expo-auth-session** (cloud backup OAuth), **react-native-iap** (one-time unlock)
- Gestures/animation: **react-native-gesture-handler**, **react-native-reanimated**

**Backend (`server/`)** — a deliberately thin proxy

- **Node ≥ 18**, **Express 4**, **multer** (inbound-email attachments), **cors**, **dotenv**
- Calls **Gemini Flash-Lite** (`gemini-3.1-flash-lite`) via the Google Generative Language REST API
- Stateless except an in-memory per-device rate counter and a short-lived pending queue
- See **[`server/README.md`](server/README.md)** for endpoints, env vars, the live E2E test, and Render deployment.

> The single source of truth for every module's API is **[`docs/AGENT_CONTRACTS.md`](docs/AGENT_CONTRACTS.md)** — read it before changing any module.

---

## Project structure

```
ReceiptScanner/
├── app/                       # expo-router routes (screens are thin wrappers)
│   ├── _layout.tsx            # root stack
│   ├── (tabs)/                # Home, History, Statistics, Mileage, Protections
│   ├── scan.tsx               # Quick Scan
│   ├── multi-scan.tsx         # Batch / stitch
│   ├── review.tsx             # The core editable Review screen
│   ├── receipt/[id].tsx       # Receipt detail
│   ├── image-viewer.tsx       # Full-screen original viewer
│   ├── statement.tsx          # Statement matching (CSV)
│   ├── tax-report.tsx         # Tax report generator
│   ├── paywall.tsx            # One-time unlock
│   ├── onboarding.tsx
│   └── settings/              # categories, payment-methods, tags, tax-categories,
│                              # filename, backup, about, index
├── src/
│   ├── components/ui/         # the shared UI kit (Screen, Card, Button, …)
│   ├── db/                    # expo-sqlite data layer + settings
│   ├── lib/                   # config, money, dates, filename, hash, csv, device, statementMatch
│   ├── screens/              # the real screen components (default-exported)
│   ├── services/             # ocr, extractClient, imagePipeline, receiptService,
│   │                         # notifications, exporters, backup, mileage, billing,
│   │                         # emailIngest, protections, taxReport
│   ├── store/                # zustand: settings, lookups, draft
│   ├── theme/                # tokens + useTheme()
│   └── types/                # all domain types (ExtractionResult, AppSettings, …)
├── docs/AGENT_CONTRACTS.md    # authoritative module API contracts
├── server/                   # the Express extraction/email proxy (own README)
├── app.json                  # Expo config + `extra` (endpoints, OAuth ids, IAP)
└── package.json
```

---

## Prerequisites

- **Node.js ≥ 18** and **npm**
- **Expo CLI** via `npx expo` (no global install needed)
- For device builds: **Xcode** (iOS) and/or **Android Studio + SDK** (Android)
- **EAS CLI** for cloud dev builds: `npm i -g eas-cli` (optional but recommended)
- A running **proxy** (local or on Render) and a **Gemini API key** — see `server/README.md`

---

## Setup

```bash
# from the repo root
npm install
```

Then point the app at your proxy and (optionally) fill in OAuth / IAP ids — see **Configuration** below.

---

## Running the Expo app

> **Important: a development build is required.** ReceiptSnap uses on-device ML Kit OCR (`@react-native-ml-kit/text-recognition`), camera, notifications, location, and IAP — native modules that are **not** in Expo Go. You must run a **dev client** build (`expo-dev-client` / EAS), not Expo Go. On web and in Expo Go these native capabilities degrade gracefully (OCR returns empty text and the app falls back to the server image-only / local heuristic extraction), but for the real experience build a dev client.

**Build & run a dev client**

```bash
# Cloud builds (recommended — no local toolchain needed):
eas build --profile development --platform ios       # or android
# then install the build on your device/simulator and start the dev server:
npx expo start --dev-client
```

```bash
# Or local native builds (requires Xcode / Android Studio):
npx expo run:ios          # = npm run ios
npx expo run:android      # = npm run android
```

**Other scripts**

```bash
npm start          # expo start (use with an installed dev client)
npm run web        # browser preview (OCR/native features degrade gracefully)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm test           # jest
```

---

## Configuration (`app.json` → `expo.extra`)

All runtime config is read from `app.json`'s `extra` block by `src/lib/config.ts` (exposed as `appConfig`). Edit `app.json` and rebuild the dev client to apply changes.

| `extra` key | `appConfig` field | What it is |
| --- | --- | --- |
| `extractApiBaseUrl` | `appConfig.apiBaseUrl` | Base URL of **your** proxy. Defaults to `http://localhost:8787` when unset. Point it at your Render service, e.g. `https://receiptsnap-proxy.onrender.com`. |
| `googleOAuthClientIdIos` | `appConfig.google.iosClientId` | Google OAuth client id (iOS) for Drive backup. |
| `googleOAuthClientIdAndroid` | `appConfig.google.androidClientId` | Google OAuth client id (Android) for Drive backup. |
| `googleOAuthClientIdWeb` | `appConfig.google.webClientId` | Google OAuth client id (web) for Drive backup. |
| `microsoftOAuthClientId` | `appConfig.microsoftClientId` | Microsoft (Entra) client id for OneDrive backup. |
| `iapProductId` | `appConfig.iapProductId` | In-app-purchase product id for the one-time unlock. Default `receiptsnap_unlock`. |
| `eas.projectId` | — | Your EAS project id (for `eas build`). |

```jsonc
// app.json (excerpt)
"extra": {
  "extractApiBaseUrl": "https://receiptsnap-proxy.onrender.com",
  "googleOAuthClientIdIos": "REPLACE_WITH_IOS_CLIENT_ID",
  "googleOAuthClientIdAndroid": "REPLACE_WITH_ANDROID_CLIENT_ID",
  "googleOAuthClientIdWeb": "REPLACE_WITH_WEB_CLIENT_ID",
  "microsoftOAuthClientId": "REPLACE_WITH_MS_CLIENT_ID",
  "iapProductId": "receiptsnap_unlock",
  "eas": { "projectId": "REPLACE_WITH_EAS_PROJECT_ID" }
}
```

> The Gemini API key is **never** placed in the app — it lives only in the proxy's environment. The app talks only to *your* proxy.
>
> Cloud backup and IAP **degrade gracefully** while the placeholders are in place: backup returns a clear "Configure OAuth client id in app.json" message, and billing returns a clear message on simulators rather than crashing.

---

## How the extraction pipeline works

ReceiptSnap is OCR-first, then AI-structured, then **human-confirmed**:

```
 Capture / import (camera · gallery · multi-page PDF · stitched long receipt)
        │   imagePipeline: enhanceImage (resize ≤2000px + contrast), autoCropHint
        ▼
 On-device OCR  ─ services/ocr.ts → ML Kit TextRecognition.recognize(uri)
        │        (returns empty text gracefully on web / Expo Go)
        ▼
 services/extractClient.ts  ── POST {apiBaseUrl}/extract
        │   body: { ocrText, imageBase64, imageMimeType, preferredDateFormat }
        │   header: X-Device-Id (from getDeviceId())
        ▼
 YOUR proxy (server/)  ── calls Gemini Flash-Lite with OCR text + image
        │   returns: { vendor, date, date_confidence, date_ambiguous, date_options,
        │              total, tax, currency, line_items[{name,qty,price}],
        │              field_confidence, return_window_days, warranty_period_days,
        │              tax_category, is_deductible, deductible_percent }
        ▼
 useDraft.startFromExtraction(...)  → Review screen (EVERY field editable)
        │   date disambiguation chips · confidence badges · live total recalc
        │   duplicate check (findPotentialDuplicates + duplicateScore)
        ▼
 receiptService.persistDraft({finalize:true})
        → user filename template applied → original image saved → SQLite upsert
        → protection reminders scheduled → scan count incremented
```

If the network is unavailable, `extractClient.localExtractFallback` does a best-effort parse of the OCR text on-device (vendor = first line, a total via regex, a currency guess, low confidence) so you're never blocked — and you can still edit everything. The exact shape is `ExtractionResult` in `src/types/index.ts`; the proxy's prompt and JSON contract are documented in `server/README.md`.

---

## Monetization

- **Free tier:** the first **25 scans** are free.
- **One-time unlock — $9.99** via Apple/Google in-app purchase (`react-native-iap`, product id `appConfig.iapProductId`). Unlock gates **unlimited scans, export, and cloud backup**.
- **No subscriptions. No ads. Ever.**

Scan gating uses `useSettings().canScan()` / `scansRemaining()`; the count is incremented only for **new** receipts. The Paywall screen surfaces `billingService.getProducts / purchaseUnlock / restorePurchases`, and a successful purchase sets `is_unlocked = true`.

---

## Privacy & cost philosophy

- **Offline-first.** Your receipts, images, line items, tags, and settings live in **local SQLite** on your device.
- **No server-side storage of your receipts.** The proxy is stateless: it forwards an extraction request to Gemini and returns the result. Email-forwarded receipts sit in a short-lived, in-memory pending queue only until your app pulls them, then they're gone.
- **Your cloud, your keys.** Backups go to **your own** Google Drive / OneDrive via OAuth — not to us.
- **No banking connections.** Statement matching is local CSV import only; no credentials are ever requested or stored.
- **Low operating cost by design.** OCR, mileage GPS, reminders, exports, and matching all run **on-device**. The only paid call is a single Gemini Flash-Lite extraction per scan, rate-limited per device (50/day, 5000 lifetime soft cap) to prevent API-cost abuse.

---

## Documentation

- **[`docs/AGENT_CONTRACTS.md`](docs/AGENT_CONTRACTS.md)** — authoritative API contracts for every store, service, lib, and screen. Start here before modifying any module.
- **[`server/README.md`](server/README.md)** — the Express proxy: endpoints, env vars, the live Gemini E2E test, and step-by-step Render deployment.

## License

Proprietary — © ReceiptSnap. All rights reserved.
