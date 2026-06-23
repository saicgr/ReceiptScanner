// Curated product roadmap — the single source of truth the app reads via
// GET /roadmap. These items are OURS (curated), not user-generated, so there's
// nothing to moderate. The app merges them with live upvote counts + the
// caller's own vote state from Supabase; offline it falls back to a bundled
// copy (src/data/roadmap.ts) that should be kept loosely in sync with this.
//
// status: 'in_progress' | 'planned' | 'shipped'
//   - 'shipped' items are non-votable (shown for credibility / "we ship").
//   - 'in_progress' + 'planned' items accept one upvote per device.
//
// `id` is a STABLE slug — votes in Supabase are keyed on it, so never rename
// an id (change the title freely instead). Bump UPDATED_AT when the list moves.

export const UPDATED_AT = '2026-06-22';

export const ROADMAP_ITEMS = [
  // ---- In progress ---------------------------------------------------------
  {
    id: 'accounting-export',
    title: 'QuickBooks, Xero & Wave export',
    description:
      'One-tap export in QuickBooks (CSV/IIF), Xero and Wave import formats — file formats only, no account linking.',
    status: 'in_progress',
    category: 'Export',
  },
  {
    id: 'gps-auto-mileage',
    title: 'Automatic GPS mileage detection',
    description:
      'Auto-detect drives and log trips in the background, on top of manual start/stop and manual entry.',
    status: 'in_progress',
    category: 'Mileage',
  },

  // ---- Planned -------------------------------------------------------------
  {
    id: 'duplicate-detection',
    title: 'Smart duplicate detection',
    description:
      'Warn before saving when a near-identical receipt (same vendor, amount and date) was already scanned.',
    status: 'planned',
    category: 'Accuracy',
  },
  {
    id: 'statement-matching-plus',
    title: 'Smarter statement matching',
    description:
      'Fuzzier amount/date matching when reconciling a CSV statement, with clearer unmatched-charge flags.',
    status: 'planned',
    category: 'Reconciliation',
  },
  {
    id: 'batch-rename',
    title: 'Batch re-name existing receipts',
    description:
      'Apply a new filename template to receipts you already saved, not just new scans.',
    status: 'planned',
    category: 'Files',
  },
  {
    id: 'shared-trips',
    title: 'Shareable trip / job folders',
    description:
      'Export a whole tagged trip or job as a single itemized package to hand to a client or accountant.',
    status: 'planned',
    category: 'Organization',
  },
  {
    id: 'more-languages',
    title: 'More receipt languages',
    description:
      'Expand OCR + extraction accuracy for non-English receipts and right-to-left scripts.',
    status: 'planned',
    category: 'Accuracy',
  },
  {
    id: 'widgets-shortcuts',
    title: 'Home-screen widget & quick actions',
    description:
      'A one-tap "Quick Scan" widget and OS share-sheet target so capture is never more than a tap away.',
    status: 'planned',
    category: 'Capture',
  },

  // ---- Shipped (credibility — non-votable) ---------------------------------
  {
    id: 'editable-everything',
    title: 'Fully editable extraction',
    description:
      'Every field — vendor, date, total, tax and each line item — is editable. Nothing is auto-finalized.',
    status: 'shipped',
    category: 'Accuracy',
  },
  {
    id: 'date-disambiguation',
    title: 'Date disambiguation',
    description:
      'Ambiguous dates are flagged and you pick the right interpretation, with a preferred-format setting.',
    status: 'shipped',
    category: 'Accuracy',
  },
  {
    id: 'email-forwarding',
    title: 'Email-receipt forwarding',
    description:
      'Forward any e-receipt to your unique inbox address and it appears in your pending list to review.',
    status: 'shipped',
    category: 'Capture',
  },
  {
    id: 'itemized-exports',
    title: 'Itemized exports',
    description:
      'Exports include every line item, memo and tag — never just totals — filterable by date, category and tag.',
    status: 'shipped',
    category: 'Export',
  },
];

/** Fast id -> item lookup for route validation. */
export const ROADMAP_BY_ID = new Map(ROADMAP_ITEMS.map((it) => [it.id, it]));
