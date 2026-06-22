# ReceiptSnap Proxy

A deliberately **thin** Node/Express proxy for the [ReceiptSnap](../README.md) app. It exists for two reasons:

1. **Hold the Gemini API key** so it is never shipped inside the mobile app, and turn an OCR-text-plus-image request into structured receipt JSON via **Gemini Flash-Lite** (`gemini-3.1-flash-lite`).
2. **Receive forwarded e-receipts** from a mail provider's webhook, run them through the same extraction pipeline, and park them in a short-lived pending queue the app polls.

The server is **stateless** except for an in-memory per-device rate-limit counter and the ephemeral pending queue. **No user receipts are ever persisted server-side.** It runs comfortably on Render's cheapest tier (a single small instance).

> The extraction JSON contract mirrors `ExtractionResult` in the app's `src/types/index.ts`. The single source of truth for how the app calls this proxy is [`../docs/AGENT_CONTRACTS.md`](../docs/AGENT_CONTRACTS.md).

---

## Device authentication

Every endpoint that costs money or exposes user data (`/extract`, `/detect-receipts`, `/pending`, `/pending/ack`, `/forwarding-address`, `/limits`) requires **two headers**:

```
X-Device-Id:    <stable per-install id>
X-Device-Token: <hex token from POST /device/register>
```

The token is a stateless `HMAC-SHA256(deviceId, DEVICE_TOKEN_SECRET)` — verification needs no token store, and a spoofed/rotated device id is useless without the matching token. Minting tokens (`POST /device/register`) is the abuse surface, so it is per-IP rate-limited (default 10/day/IP). An invalid pair returns `401 unauthorized`; the app transparently re-registers and retries once.

> **Production-grade upgrade path:** an HMAC token stops casual header spoofing and id rotation, but a determined attacker with many IPs can still mint identities. The real fix is **platform attestation** — Apple **App Attest** / **DeviceCheck** and Google **Play Integrity** — verified server-side at `/device/register` so only genuine installs of your signed app can obtain a token. The endpoint shape here was chosen so attestation can slot in without changing the client contract.

## Endpoints

All JSON. **No CORS middleware** — the only clients are the native apps and the mail webhook, neither of which needs CORS (a browser page can't call this API, which is intentional). Body limits are per-route: 50 KB for small control routes, 12 MB for the image-bearing extract/detect routes, 30 MB for inbound-email JSON (multipart uploads: 10 MB/file, max 5 files).

### `POST /device/register`
Body `{ "deviceId": "<stable id, ≤128 chars>" }` → `{ "deviceToken": "<64-char hex>" }`. Deterministic per device id. Per-IP limited (`REGISTER_PER_DAY_PER_IP`, default 10/day) → `429 ip_daily_cap` beyond that.

### `GET /health`
Liveness + config sanity. Returns:
```json
{ "ok": true, "service": "receiptsnap-proxy", "model": "gemini-3.1-flash-lite",
  "geminiConfigured": true, "time": "2026-06-04T00:00:00.000Z" }
```

### `POST /extract`  — the core endpoint
The app POSTs OCR text and/or a base64 image; the proxy calls Gemini and returns structured JSON.

- **Headers (required):** `X-Device-Id` + `X-Device-Token` (see *Device authentication*)
- **Body:**
  ```json
  { "ocrText": "…", "imageBase64": "…", "imageMimeType": "image/jpeg",
    "preferredDateFormat": "MM/DD/YYYY" }
  ```
  At least one of `ocrText` / `imageBase64` is required (else `400`).
- **Response:** the full extraction object plus a `_meta` block:
  ```json
  {
    "vendor": "…", "date": "2025-12-05",
    "date_confidence": "high", "date_ambiguous": true,
    "date_options": ["2025-12-05", "2005-12-25"],
    "total": 42.17, "tax": 3.10, "currency": "USD",
    "field_confidence": { "vendor": "high", "date": "medium", "total": "high", "tax": "low" },
    "line_items": [
      { "name": "USB-C Cable", "qty": 1, "price": 12.99,
        "return_window_days": 30, "warranty_period_days": 365 }
    ],
    "return_window_days": 30, "warranty_period_days": 365,
    "tax_category": "Supplies", "is_deductible": true, "deductible_percent": 100,
    "_meta": { "remainingToday": 49, "lifetimeRemaining": 4999, "model": "gemini-3.1-flash-lite" }
  }
  ```

**Date disambiguation** is the headline behavior: when a date is genuinely ambiguous (2-digit year, or both day and month ≤ 12, or unclear separators) the prompt forces `date_ambiguous: true` and enumerates every plausible ISO reading in `date_options` (preferred-format reading first). `preferredDateFormat` only *orders* the options — it never suppresses the ambiguity flag. Server-side, dates are hardened to real calendar dates (`toIsoDate` rejects things like `2021-02-30`), and ambiguity is only kept when more than one valid interpretation survives.

**V2 fields** — `return_window_days`, `warranty_period_days` (receipt- and item-level), `tax_category`, `is_deductible`, `deductible_percent` — are inferred best-effort and are fully editable in the app. They are **backward-compatible**: when the model can't infer them they are `null`, and the app treats their absence safely.

Errors: `400 bad_request` (no input — validated **before** any quota is consumed), `401 unauthorized` (bad/missing device token), `429` (`daily_cap` / `lifetime_cap` / `ip_daily_cap` / `global_daily_cap`), `502 extraction_failed` (Gemini error). **A Gemini 5xx or timeout refunds the consumed scan** — failed calls never burn quota. If a model rejects `responseSchema`, the proxy automatically retries once without it.

Quota layers (in order): per-IP backstop (`EXTRACT_PER_DAY_PER_IP`, shared with `/detect-receipts`) → per-device daily/lifetime caps → the **global daily Gemini cap** (`GLOBAL_DAILY_GEMINI_CAP`), a service-wide billing circuit breaker that 429s every Gemini-backed route once the day's budget is spent.

### `POST /inbound-email`  — mail-provider webhook
Where your mail provider posts messages sent to `*@<FORWARDING_DOMAIN>`. Accepts **both** `application/json` (normalized) **and** `multipart/form-data` (SendGrid Inbound Parse style with uploaded files). It derives the user's token from the recipient address (`user-<token>@…`), runs each PDF/image attachment (or the email body for digital receipts) through the same Gemini pipeline, and enqueues the results. Returns `{ ok, token, ingested, ids }`.

Abuse controls:
- Guarded by the `INBOUND_EMAIL_SECRET` shared secret, compared in constant time. Prefer the **`X-Inbound-Secret` header**; the `?secret=` query param is supported only because SendGrid Inbound Parse can't send custom headers — **query strings can leak into proxy/access logs**, so rotate the secret if you suspect exposure and use the header wherever possible.
- **In production an unset secret DISABLES the route** (`503 inbound_email_disabled` + a log line) instead of leaving a Gemini-billing endpoint open to the internet. It is only open-without-secret in dev.
- Uploads capped at 10 MB/file, 5 files; at most **3 supported attachments are processed per email** (the rest are logged and skipped). Every attachment draws from the global daily Gemini cap.

### `GET /pending`  — app pulls forwarded receipts
Authed (`X-Device-Id` + `X-Device-Token`); the queue is resolved from the **authenticated** device id — the short email-routing token no longer grants read access by itself. Returns:
```json
{ "token": "ab12cd34ef",
  "items": [ { "id": "uuid", "extraction": { … }, "imageBase64": null,
              "imageMimeType": null, "source": "email", "receivedAt": "…" } ] }
```
Queue bounds: images over ~2 MB are dropped at enqueue (the extraction is kept), max 25 items per user, ~100 MB held globally (oldest evicted first), TTL `PENDING_TTL_MS`.

### `POST /pending/ack`  — clear the queue
Authed. Body `{ "ids": ["uuid", …] }`. Removes those entries from the calling device's queue (they also auto-expire after `PENDING_TTL_MS`). Returns `{ ok: true, removed: <n> }`.

### `GET /forwarding-address`  — mint a user's inbox address
Authed. Deterministic per device. Returns:
```json
{ "token": "ab12cd34ef", "address": "user-ab12cd34ef@inbox.receiptsnap.app" }
```

### `GET /limits`  — rate-limit status (no consume)
Authed. → `{ "remainingToday": 50, "lifetimeRemaining": 5000 }`.

---

## Environment variables

Copy `.env.example` → `server/.env` (the loader also falls back to the repo-root `.env`), or set these in the Render dashboard.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | **yes** | — | Google Generative Language API key. Held only here, sent via the `x-goog-api-key` header (never in URLs, which leak into logs). |
| `GEMINI_MODEL` | no | `gemini-3.1-flash-lite` | Model name (any Generative Language model works). |
| `GEMINI_BASE_URL` | no | `https://generativelanguage.googleapis.com/v1beta` | REST base override. |
| `PORT` | no | `8787` | Listen port (Render injects its own `PORT`). |
| `DEVICE_TOKEN_SECRET` | **yes in production** | _(insecure dev fallback)_ | HMAC secret behind `/device/register` tokens. Generate with `openssl rand -hex 32`. **Production refuses to boot without it**; dev uses a fixed fallback and logs a warning. |
| `RATE_LIMIT_PER_DAY` | no | `50` | Max `/extract` calls per device per calendar day. |
| `RATE_LIMIT_LIFETIME` | no | `5000` | Lifetime soft cap per device. |
| `REGISTER_PER_DAY_PER_IP` | no | `10` | Per-IP daily cap on `/device/register` (identity-minting backstop). |
| `EXTRACT_PER_DAY_PER_IP` | no | `200` | Per-IP daily backstop shared by `/extract` + `/detect-receipts`. |
| `GLOBAL_DAILY_GEMINI_CAP` | no | `2000` | Billing circuit breaker: total Gemini calls/day across ALL routes (429 once spent). |
| `INBOUND_EMAIL_SECRET` | **yes in production** | _(empty = open in dev, **503 in production**)_ | Shared secret the mail webhook must present (`X-Inbound-Secret` header preferred; `?secret=` only for providers that can't set headers). Generate with `openssl rand -hex 32`. |
| `FORWARDING_DOMAIN` | no | `inbox.receiptsnap.app` | Domain in minted addresses: `user-<token>@<FORWARDING_DOMAIN>`. |
| `PENDING_TTL_MS` | no | `259200000` (72 h) | How long un-acked email receipts live in the in-memory queue. |

> If `GEMINI_API_KEY` is missing the server still boots (it logs a warning); `/extract` will then fail with a clear Gemini error. `assertConfigured()` enforces it when run directly.

### Memory bounds

All server state is in-memory and bounded: the rate-limit counter maps hold at most ~50 000 entries (stale-day entries are swept first, then oldest-inserted evicted), and the pending queue enforces 2 MB/image, 25 items/user, and ~100 MB total (oldest evicted). A long-running small instance can't be ballooned by traffic.

---

## Run locally

```bash
cd server
npm install
npm start            # node src/index.js  →  listening on :8787
# or, with hot reload:
npm run dev          # node --watch src/index.js
```

Point the app at it by setting `extractApiBaseUrl` in the repo-root `app.json` `extra` block to `http://<your-machine-ip>:8787` (a simulator can use `http://localhost:8787`).

Quick smoke test:
```bash
curl localhost:8787/health
```

---

## End-to-end test against the live Gemini API

The repo ships a real E2E test that boots the Express app on an ephemeral port, **downloads real receipt images** (ICDAR-2019-SROIE scanned store receipts + a clean printed invoice template, cached under `server/fixtures/`), and exercises the full surface: `/health`, `/forwarding-address`, `/extract` for every fixture (validating the JSON contract and `_meta`), bad-input handling, `/limits`, and the inbound-email → `/pending` → `/pending/ack` flow.

```bash
cd server
# requires a working GEMINI_API_KEY in .env (or repo-root .env)
node scripts/test-extract.js     # or: npm run test:extract
```

It prints a `✓`/`✗` line per check and a `PASS/FAIL` summary, exiting non-zero on any failure. **This suite has been run against the live Gemini API and passes 14/14** — confirming the contract, date disambiguation, the V2 warranty/return/tax fields, rate-limit metadata, and the email-ingest queue end to end. (Fixtures download once and are cached; you can pre-fetch them with `node scripts/fixtures.js`.)

### Robustness gauntlet (hard cases)

Because accuracy on *hard* inputs is the whole point (the competitor failed here), a second suite runs a **diverse, categorized corpus**:

```bash
cd server
node scripts/test-gauntlet.js     # or: npm run test:gauntlet
```

- **15 real receipts** — clean printed + 13 real-world **ICDAR-SROIE thermal scans** that are faded, skewed, crumpled, partial, multi-currency (MYR/USD), with discounts and GST. The pipeline must never crash or break contract, and a strong majority must yield usable data.
- **Stitched long receipt** — several photos are vertically combined (via `jimp`) into one tall image and extracted, exercising the multi-photo "one long receipt" capture path.
- **Multi-page PDF** — a 2-page grocery e-receipt (generated by `scripts/make-pdf.js`) is sent as `application/pdf`; the extractor must read **across both pages**, merge the line items, detect EUR and the €25.28 total.
- **Non-receipts** — a dog, a face, and a scene photo. These MUST degrade gracefully: empty vendor, `total = 0`, no line items, `low` confidence, and **never** a hallucinated receipt or a literal `"not found"` (the exact way the competitor embarrassed itself).

**Last run: ALL CHECKS PASSED ✅** — 15/15 (100%) real receipts extracted meaningful data; the stitched image extracted cleanly; the 2-page PDF merged 8 items across pages at EUR 25.28; all 3 non-receipts degraded safely. The corpus lives in `server/fixtures/`.

---

## Deploy to Render (free / cheapest tier)

1. **Create the service.** In the Render dashboard → **New → Web Service** → connect this repo.
   - **Root Directory:** `server`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (or the cheapest paid tier to avoid cold starts)
2. **Set environment variables** (dashboard → *Environment*): at minimum `GEMINI_API_KEY` and `DEVICE_TOKEN_SECRET` (required — production exits without it; `openssl rand -hex 32`). Set `GEMINI_MODEL=gemini-3.1-flash-lite`, and for the forwarding feature set `INBOUND_EMAIL_SECRET` (also required in production — the route is disabled without it) and `FORWARDING_DOMAIN`. Tune `RATE_LIMIT_PER_DAY` / `RATE_LIMIT_LIFETIME` / `GLOBAL_DAILY_GEMINI_CAP` as desired. (Render injects `PORT` automatically — leave it unset. The app already sets `trust proxy` for Render's load balancer so per-IP limits see real client IPs.)
3. **Deploy** and confirm: open `https://<your-service>.onrender.com/health` and check `geminiConfigured: true` and the right `model`.
4. **Point the app at it.** Set `extractApiBaseUrl` in the repo-root `app.json` `extra` to your Render URL and rebuild the dev/production client.

### Wiring the inbound-email webhook

Give the proxy a public domain for receiving mail (`FORWARDING_DOMAIN`, e.g. `inbox.receiptsnap.app`) and route inbound mail to `POST https://<your-service>.onrender.com/inbound-email`.

- **SendGrid Inbound Parse:** add an MX record for `inbox.receiptsnap.app` pointing at SendGrid, then in *Settings → Inbound Parse* add a host + destination URL `https://<your-service>.onrender.com/inbound-email`. SendGrid posts `multipart/form-data` with `to`/`from`/`subject`/`text`/`envelope` fields and file attachments — handled natively (via multer). Pass the shared secret as a query param (`…/inbound-email?secret=<INBOUND_EMAIL_SECRET>`) since Parse can't add custom headers. **Risk note:** a query-string secret can end up in proxy/access logs along the path — accept this only for providers that can't send headers, and rotate the secret if you suspect it leaked.
- **Mailgun Routes / Postmark / others:** create a route/webhook that forwards `*@inbox.receiptsnap.app` to the same URL. If your provider can send custom headers, add `X-Inbound-Secret: <INBOUND_EMAIL_SECRET>`; otherwise use the `?secret=` query param. Providers that POST normalized JSON (`{ to, from, subject, text, attachments:[{contentType, contentBase64}] }`) are also supported directly.

Once mail flows in, the app's `emailIngestService` (which polls `/pending`) will surface forwarded receipts in the user's pending review list.

---

## Project layout

```
server/
├── src/
│   ├── index.js          # Express app + all routes (default-exports `app` for tests)
│   ├── config.js         # env loading + config object + assertConfigured()
│   ├── deviceAuth.js     # stateless HMAC device tokens (/device/register + middleware)
│   ├── gemini.js         # Gemini client, the extraction prompt, JSON hardening (normalize/toIsoDate)
│   ├── inboundEmail.js   # webhook handler: address→token, run pipeline, enqueue
│   ├── pendingStore.js   # ephemeral in-memory per-user pending queue (TTL-swept, size-capped)
│   └── rateLimit.js      # per-device, per-IP and global daily counters (bounded maps)
├── scripts/
│   ├── fixtures.js       # downloads & caches real receipt images
│   └── test-extract.js   # live Gemini E2E suite (14/14)
├── fixtures/             # cached test images
├── .env.example
└── package.json
```
