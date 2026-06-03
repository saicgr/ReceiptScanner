Build a cross-platform mobile receipt scanner app called "ReceiptSnap" using React Native (Expo).
This is a ONE-TIME-PURCHASE app (NO subscriptions, NO ads). Prioritize accuracy, full user 
editability, offline-first design, and low operating cost.

This app is designed to beat a competitor whose users complained about: poor accuracy with no 
way to correct it, ambiguous date parsing, inability to control the saved filename, weak bulk 
scanning, not being able to view the full original image, not being able to delete line items, 
and exports that only show totals instead of itemized data. Solve ALL of these.

==== CAPTURE & SCANNING ====
- Home screen with "Quick Scan" (single receipt) and "Multi Scan" (batch) buttons.
- Multi Scan must support TWO modes:
    (a) multiple separate receipts in one session, AND
    (b) stitching ONE long receipt from several photos into a single combined receipt.
- Capture via camera, import from gallery, or import a PDF (including MULTI-PAGE PDFs and 
  multi-page documents).
- Auto-crop and enhance on-device.
- ALWAYS keep and store the full original image; user can open/view it full-screen at any time, 
  and share it or open it in other apps.

==== EMAIL-RECEIPT FORWARDING (borrowed from Expensify) ====
- Give each user a unique forwarding address (e.g. user-xxxx@inbox.receiptsnap.app).
- Receipts emailed/forwarded to that address are auto-ingested: the backend parses the email 
  body and any PDF/image attachment through the same Gemini extraction pipeline and adds them 
  to the user's pending list to review.
- This captures digital/e-receipts, not just paper.

==== EXTRACTION & ACCURACY (top priority — competitor failed here) ====
- Run on-device OCR first, then POST OCR text + image to a backend proxy (POST /extract) that 
  calls Gemini Flash-Lite, returning JSON:
  { vendor, date, date_confidence, date_ambiguous (bool), total, tax, currency, 
    line_items: [{name, qty, price}] }.
- EVERY extracted field MUST be editable on a review screen. Nothing is ever auto-finalized.
- DATE DISAMBIGUATION: when a date is ambiguous (e.g. "25/12/05" could be Dec 5 2025 or 
  Dec 25 2005), set date_ambiguous=true, show the possible interpretations, and make the user 
  pick. Let users set a preferred date format in Settings to reduce ambiguity.
- Show a confidence indicator so users know which fields to double-check.
- Line items: user can edit, add, or DELETE individual line items; unticking/deleting an item 
  automatically recalculates the total in real time.

==== ORGANIZATION ====
- Custom categories: user-defined, editable in Settings.
- Payment method tagging: cash, bank account, credit card, debit, gift card, PayPal 
  (user can add more).
- Split transactions: assign different line items to different categories within one receipt.
- Memo/description field per receipt.
- TAGS for grouping by trip or job; filter history by tag/job AND export by tag/job.

==== MILEAGE TRACKING (borrowed from Shoeboxed/Expensify) ====
- On-device GPS trip logging (auto-detect or manual start/stop) plus manual mileage entry.
- Apply a configurable per-mile rate; mileage entries flow into reports and categories.
- Runs fully on-device (no per-use API cost).

==== FILENAME CONTROL (explicit user demand) ====
- When saving the scanned image (JPG or PNG, user's choice), the filename MUST be fully 
  user-configurable via a template in Settings.
- Default template: {date}_{company}_{amount} and NOTHING else.
- Allow reorder/remove of tokens, apply automatically to every scan, AND support batch 
  re-naming of existing receipts.

==== STATEMENT MATCHING (lightweight, borrowed from Expensify) ====
- Let the user import a bank/card statement as CSV.
- Auto-match scanned receipts to statement line items by amount + date proximity; flag 
  unmatched charges (possible missing receipts) and unmatched receipts.
- NO live bank connections, NO storing of banking credentials — CSV import only.

==== STORAGE, EXPORT & BACKUP ====
- Local SQLite database, offline-first. No server-side storage of user receipts.
- Backup/restore to the USER'S OWN Google Drive / OneDrive.
- Export to CSV/Excel and PDF. Exports MUST be ITEMIZED (every line item), not just totals, and 
  MUST include the memo/description field and tags. Support exporting filtered by date range, 
  category, and tag/job.
- ACCOUNTING-SOFTWARE EXPORT: also export in QuickBooks-compatible CSV/IIF, Xero, and Wave 
  import formats (file formats only — no live API integrations).
- Multi-currency: store currency per receipt; statistics group totals by currency correctly.
- Duplicate detection: warn if a near-identical receipt was already scanned.

==== SCREENS ====
Home, Scan/Review (editable), History (searchable + filter by category/tag/job), 
Statistics (spend by category/month, per-currency), Mileage, Settings (categories, payment 
methods, filename template, date format, forwarding address, backup), Share-with-friends link, 
About section.

==== MONETIZATION ====
- Free tier: first 25 scans free.
- One-time unlock ($9.99) via Apple/Google in-app purchase (expo-in-app-purchases). 
  Gate unlimited scans + export + cloud backup behind purchase. No subscriptions, no ads.

==== BACKEND (minimal) ====
- Thin Node/Express proxy on Render (cheapest tier), holding the Gemini API key 
  (never ship the key in the app).
- POST /extract: rate-limited (max 50 scans/day/device, lifetime soft cap 5000) to prevent 
  API-cost abuse. Stateless except a per-device rate-limit counter.
- An inbound-email handler for the forwarding feature (parse attachment/body -> /extract -> 
  push to user's pending list). No persistent storage of user receipts on the server.

Generate the full project structure, the React Native app, and the Express proxy, with clear 
comments and a README covering setup + Render deployment.
