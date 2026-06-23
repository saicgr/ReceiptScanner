/**
 * Bundled roadmap fallback. The live list comes from the proxy's `GET /roadmap`
 * (curated in server/src/roadmapData.js); this copy is what the Roadmap screen
 * shows when the device is fully offline and there's no cached response yet, so
 * the screen is never blank. Keep it loosely in sync with the server list —
 * it's intentionally a static snapshot with no vote data.
 */

export type RoadmapStatus = 'in_progress' | 'planned' | 'shipped';

export interface RoadmapItem {
  id: string;
  title: string;
  description: string;
  status: RoadmapStatus;
  category?: string | null;
  /** Aggregate upvotes; 0 in the bundled fallback (no live data offline). */
  upvotes: number;
  /** Whether THIS device has upvoted; always false in the fallback. */
  voted: boolean;
}

export const BUNDLED_ROADMAP: RoadmapItem[] = [
  {
    id: 'accounting-export',
    title: 'QuickBooks, Xero & Wave export',
    description:
      'One-tap export in QuickBooks (CSV/IIF), Xero and Wave import formats — file formats only, no account linking.',
    status: 'in_progress',
    category: 'Export',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'gps-auto-mileage',
    title: 'Automatic GPS mileage detection',
    description:
      'Auto-detect drives and log trips in the background, on top of manual start/stop and manual entry.',
    status: 'in_progress',
    category: 'Mileage',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'duplicate-detection',
    title: 'Smart duplicate detection',
    description:
      'Warn before saving when a near-identical receipt (same vendor, amount and date) was already scanned.',
    status: 'planned',
    category: 'Accuracy',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'statement-matching-plus',
    title: 'Smarter statement matching',
    description:
      'Fuzzier amount/date matching when reconciling a CSV statement, with clearer unmatched-charge flags.',
    status: 'planned',
    category: 'Reconciliation',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'batch-rename',
    title: 'Batch re-name existing receipts',
    description:
      'Apply a new filename template to receipts you already saved, not just new scans.',
    status: 'planned',
    category: 'Files',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'shared-trips',
    title: 'Shareable trip / job folders',
    description:
      'Export a whole tagged trip or job as a single itemized package to hand to a client or accountant.',
    status: 'planned',
    category: 'Organization',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'more-languages',
    title: 'More receipt languages',
    description:
      'Expand OCR + extraction accuracy for non-English receipts and right-to-left scripts.',
    status: 'planned',
    category: 'Accuracy',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'widgets-shortcuts',
    title: 'Home-screen widget & quick actions',
    description:
      'A one-tap "Quick Scan" widget and OS share-sheet target so capture is never more than a tap away.',
    status: 'planned',
    category: 'Capture',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'editable-everything',
    title: 'Fully editable extraction',
    description:
      'Every field — vendor, date, total, tax and each line item — is editable. Nothing is auto-finalized.',
    status: 'shipped',
    category: 'Accuracy',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'date-disambiguation',
    title: 'Date disambiguation',
    description:
      'Ambiguous dates are flagged and you pick the right interpretation, with a preferred-format setting.',
    status: 'shipped',
    category: 'Accuracy',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'email-forwarding',
    title: 'Email-receipt forwarding',
    description:
      'Forward any e-receipt to your unique inbox address and it appears in your pending list to review.',
    status: 'shipped',
    category: 'Capture',
    upvotes: 0,
    voted: false,
  },
  {
    id: 'itemized-exports',
    title: 'Itemized exports',
    description:
      'Exports include every line item, memo and tag — never just totals — filterable by date, category and tag.',
    status: 'shipped',
    category: 'Export',
    upvotes: 0,
    voted: false,
  },
];
