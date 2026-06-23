/**
 * StatementMatchScreen — lightweight, Expensify-style bank/card reconciliation
 * (item 10 in the SCREENS contract). NO live bank connections and NO storage of
 * banking credentials: the user imports a CSV they exported themselves, and we
 * match it against locally-scanned receipts entirely on-device.
 *
 * Flow:
 *   1. Pick a CSV via expo-document-picker, read it with expo-file-system.
 *   2. `parseStatementCsv` normalizes it into {date, amount, description} lines.
 *   3. Persist the import with `DB.Statements.createImport` (each line starts
 *      unmatched: matched_receipt_id=null, match_score=0).
 *   4. Load receipts and run the pure `matchStatement` matcher to get a greedy
 *      best-match for each line by amount + date proximity.
 *   5. Render three sections so the user can see (and fix) the full picture:
 *        • Matched          — line ⇄ receipt + score, confirm to persist.
 *        • Unmatched charges — statement lines with no receipt (POSSIBLY MISSING
 *                              receipts the user forgot to scan).
 *        • Unmatched receipts— receipts with no statement line (scanned but not
 *                              on this statement — duplicates, cash, etc.).
 *
 * The matcher only *suggests*. Nothing is final until the user taps "Confirm",
 * which writes the match through `DB.Statements.setLineMatch`. Confirmed matches
 * survive across re-imports/reloads because they're read back from the line rows.
 *
 * All money renders through `formatMoney(amount, currency)` and all dates through
 * `formatDate(iso, settings.date_format)` — never interpolated raw.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  IconButton,
  LoadingOverlay,
  Row,
  Screen,
  SectionHeader,
  Spacer,
  Text,
  useTheme,
} from '@/components/ui';
import { useSettings } from '@/store/settings';
import * as DB from '@/db';
import {
  matchStatement,
  type LineMatch,
  type MatchableReceipt,
  type RawStatementLine,
} from '@/lib/statementMatch';
import { parseStatementCsv } from '@/lib/statementMatch';
import { buildStatementInsights } from '@/services/statementInsights';
import { cadenceLabel } from '@/lib/recurringCharges';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import type { Receipt, StatementLine } from '@/types';

/**
 * A persisted statement line paired with the matcher's suggestion and the
 * receipt it points at (if any). We keep the persisted `StatementLine` so we can
 * read back already-confirmed matches and write changes via `setLineMatch`.
 */
interface MatchedRow {
  line: StatementLine;
  receipt: Receipt;
  /** Suggested (or already-confirmed) score, 0..1. */
  score: number;
  /** True once the user has confirmed this match (persisted to the DB). */
  confirmed: boolean;
}

export default function StatementMatchScreen() {
  const t = useTheme();
  const { settings } = useSettings();
  const dateFmt = settings.date_format;

  // Persisted statement lines for the MOST RECENT import (what we reconcile).
  const [lines, setLines] = useState<StatementLine[]>([]);
  const [importName, setImportName] = useState<string | null>(null);
  // All receipts, kept so we can resolve ids -> Receipt for display.
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState('Working…');

  /** Fast id -> Receipt lookup for rendering matched/unmatched receipt rows. */
  const receiptById = useMemo(() => {
    const m = new Map<string, Receipt>();
    for (const r of receipts) m.set(r.id, r);
    return m;
  }, [receipts]);

  /**
   * Load the latest import's lines + all receipts from the DB. We reconcile only
   * the newest statement import (the typical "I just exported my card statement"
   * use case); older imports stay in the DB and can be re-imported as needed.
   */
  const load = useCallback(async () => {
    const [imports, allReceipts] = await Promise.all([
      DB.Statements.listImports(),
      DB.listReceipts({ status: 'all', orderBy: 'date_desc' }),
    ]);
    setReceipts(allReceipts);
    const latest = imports[0];
    if (!latest) {
      setLines([]);
      setImportName(null);
      return;
    }
    setImportName(latest.filename);
    setLines(await DB.Statements.listLines(latest.id));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /**
   * Run the pure matcher over the persisted lines. We feed receipts as
   * `MatchableReceipt` (id/date/total/vendor) per the contract. The matcher is a
   * SUGGESTION engine; user-confirmed matches (already persisted on the line)
   * take precedence so confirming one match never silently re-shuffles others.
   */
  const suggestion = useMemo(() => {
    const raw: RawStatementLine[] = lines.map((l) => ({
      date: l.date,
      amount: l.amount,
      description: l.description,
    }));
    const matchable: MatchableReceipt[] = receipts.map((r) => ({
      id: r.id,
      date: r.date,
      total: r.total,
      vendor: r.vendor,
    }));
    return matchStatement(raw, matchable);
  }, [lines, receipts]);

  /**
   * Build the three display sections. We index the matcher output by line index
   * (lines and `suggestion.matches` share order). A line that already carries a
   * persisted `matched_receipt_id` is treated as a confirmed match regardless of
   * what the fresh matcher suggests.
   */
  const { matchedRows, unmatchedLines, unmatchedReceipts } = useMemo(() => {
    const matched: MatchedRow[] = [];
    const unLines: StatementLine[] = [];
    // Track which receipts end up claimed by a line so we can compute the
    // "scanned but not on statement" set from the remainder.
    const claimedReceiptIds = new Set<string>();

    lines.forEach((line, idx) => {
      // Prefer a persisted/confirmed match; otherwise use the matcher suggestion.
      const persistedId = line.matched_receipt_id;
      const suggested: LineMatch | undefined = suggestion.matches[idx];
      const receiptId = persistedId ?? suggested?.receiptId ?? null;
      const receipt = receiptId ? receiptById.get(receiptId) ?? null : null;

      if (receipt) {
        claimedReceiptIds.add(receipt.id);
        matched.push({
          line,
          receipt,
          // Show the persisted score when confirmed, else the suggestion's.
          score: persistedId ? line.match_score || suggested?.score || 1 : suggested?.score ?? 0,
          confirmed: !!persistedId,
        });
      } else {
        unLines.push(line);
      }
    });

    const unReceipts = receipts.filter((r) => !claimedReceiptIds.has(r.id));
    return { matchedRows: matched, unmatchedLines: unLines, unmatchedReceipts: unReceipts };
  }, [lines, suggestion, receiptById, receipts]);

  // TASKS 82/83/85 — recurring charges, duplicate/overcharge anomalies, and
  // missing-deduction nudges, all derived from the persisted statement lines.
  const insights = useMemo(() => buildStatementInsights(lines), [lines]);
  // Fast lookup so anomaly/recurring rows can show a line's description.
  const lineByIndex = useCallback(
    (i: number) => lines[i] ?? null,
    [lines],
  );

  // ---- Actions -------------------------------------------------------------

  /** Pick + parse + persist a CSV statement, then reload everything. */
  const importCsv = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        // Bank exports are usually text/csv but sometimes mislabeled; accept any.
        type: ['text/csv', 'text/comma-separated-values', 'application/vnd.ms-excel', '*/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) return;

      setBusyMsg('Importing statement…');
      setBusy(true);

      const text = await FileSystem.readAsStringAsync(asset.uri);
      const parsed = parseStatementCsv(text);
      if (parsed.length === 0) {
        Alert.alert(
          'No transactions found',
          'We couldn’t find date/amount columns in that file. Make sure it’s a CSV exported from your bank or card.',
        );
        return;
      }

      // Persist every line as initially unmatched per the contract; the matcher
      // and the user fill in matches afterward.
      await DB.Statements.createImport(
        asset.name ?? 'statement.csv',
        parsed.map((l) => ({
          date: l.date,
          amount: l.amount,
          description: l.description,
          matched_receipt_id: null,
          match_score: 0,
        })),
      );

      await load();
    } catch {
      Alert.alert('Import failed', 'Could not read that file. Please try a CSV export.');
    } finally {
      setBusy(false);
    }
  }, [load]);

  /** Persist a suggested (or user-selected) match for a single line. */
  const confirmMatch = useCallback(
    async (row: MatchedRow) => {
      await DB.Statements.setLineMatch(row.line.id, row.receipt.id, row.score || 1);
      await load();
    },
    [load],
  );

  /** Undo a confirmed match (frees the receipt to be matched elsewhere). */
  const clearMatch = useCallback(
    async (row: MatchedRow) => {
      await DB.Statements.setLineMatch(row.line.id, null, 0);
      await load();
    },
    [load],
  );

  const openReceipt = useCallback((id: string) => {
    router.push({ pathname: '/receipt/[id]', params: { id } });
  }, []);

  // Headline counts for the intro card.
  const suggestedCount = matchedRows.filter((m) => !m.confirmed).length;
  const confirmedCount = matchedRows.filter((m) => m.confirmed).length;

  const hasImport = lines.length > 0;

  return (
    <Screen scroll>
      <Text variant="title">Statement Match</Text>
      <Text variant="body" color={t.colors.textMuted}>
        Reconcile a bank or card statement against your scanned receipts. Import a
        CSV you exported yourself — no bank logins, no credentials stored.
      </Text>

      <Spacer size={t.spacing.lg} />
      <Button title="Import statement CSV" icon="cloud-upload-outline" onPress={importCsv} />

      {!hasImport ? (
        <>
          <Spacer size={t.spacing.xl} />
          <EmptyState
            icon="swap-horizontal-outline"
            title="No statement imported"
            message="Export a CSV from your bank or card account, then import it here to spot missing receipts and unmatched charges."
          />
        </>
      ) : (
        <>
          {/* ---- Import summary ---- */}
          <Card style={{ marginTop: t.spacing.lg }}>
            <Row justify="space-between" align="flex-start">
              <View style={{ flex: 1, paddingRight: t.spacing.sm }}>
                <Text variant="subheading" numberOfLines={1}>
                  {importName ?? 'Statement'}
                </Text>
                <Text variant="caption" color={t.colors.textMuted}>
                  {`${lines.length} line${lines.length === 1 ? '' : 's'} · ${confirmedCount} confirmed · ${suggestedCount} suggested`}
                </Text>
              </View>
              <Badge
                label={`${unmatchedLines.length} to review`}
                icon="alert-circle"
                color={unmatchedLines.length ? t.colors.warning : t.colors.success}
                background={unmatchedLines.length ? t.colors.warningTint : t.colors.successTint}
              />
            </Row>
          </Card>

          {/* ---- Matched (line <-> receipt + score) ---- */}
          <SectionHeader title={`Matched (${matchedRows.length})`} />
          {matchedRows.length === 0 ? (
            <Card>
              <Text variant="body" color={t.colors.textMuted}>
                No matches yet. Statement lines below couldn’t be paired with a
                scanned receipt by amount and date.
              </Text>
            </Card>
          ) : (
            <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
              {matchedRows.map((row, i) => (
                <View key={row.line.id}>
                  {i > 0 ? <Divider spacing={0} /> : null}
                  <MatchedRowView
                    row={row}
                    dateFmt={dateFmt}
                    onConfirm={() => confirmMatch(row)}
                    onClear={() => clearMatch(row)}
                    onOpenReceipt={() => openReceipt(row.receipt.id)}
                  />
                </View>
              ))}
            </Card>
          )}

          {/* ---- Unmatched charges (possible MISSING receipts) ---- */}
          <SectionHeader title={`Unmatched charges (${unmatchedLines.length})`} />
          {unmatchedLines.length === 0 ? (
            <Card>
              <Text variant="body" color={t.colors.textMuted}>
                Every charge on this statement is matched to a receipt. Nothing
                appears to be missing.
              </Text>
            </Card>
          ) : (
            <>
              <Text variant="caption" color={t.colors.textMuted} style={{ marginBottom: t.spacing.sm }}>
                These charges have no matching receipt — you may have forgotten to
                scan one.
              </Text>
              <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
                {unmatchedLines.map((line, i) => (
                  <View key={line.id}>
                    {i > 0 ? <Divider spacing={0} /> : null}
                    <Row align="center" style={{ paddingVertical: t.spacing.md }}>
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: t.radius.md,
                          backgroundColor: t.colors.warningTint,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <IconButton icon="help-outline" color={t.colors.warning} />
                      </View>
                      <View style={{ flex: 1, paddingHorizontal: t.spacing.md }}>
                        <Text variant="body" weight="500" numberOfLines={1}>
                          {line.description || 'Charge'}
                        </Text>
                        <Text variant="caption" color={t.colors.textMuted}>
                          {line.date ? formatDate(line.date, dateFmt) : 'No date'}
                        </Text>
                      </View>
                      <Text variant="body" weight="600">
                        {formatMoney(line.amount, settings.default_currency)}
                      </Text>
                    </Row>
                  </View>
                ))}
              </Card>
            </>
          )}

          {/* ---- Unmatched receipts (scanned but not on statement) ---- */}
          <SectionHeader title={`Unmatched receipts (${unmatchedReceipts.length})`} />
          {unmatchedReceipts.length === 0 ? (
            <Card>
              <Text variant="body" color={t.colors.textMuted}>
                Every scanned receipt is accounted for on this statement.
              </Text>
            </Card>
          ) : (
            <>
              <Text variant="caption" color={t.colors.textMuted} style={{ marginBottom: t.spacing.sm }}>
                Scanned receipts that don’t appear on this statement — e.g. cash
                purchases, a different account, or duplicates.
              </Text>
              <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
                {unmatchedReceipts.map((r, i) => (
                  <View key={r.id}>
                    {i > 0 ? <Divider spacing={0} /> : null}
                    <Row
                      align="center"
                      style={{ paddingVertical: t.spacing.md }}
                    >
                      <View style={{ flex: 1, paddingRight: t.spacing.md }}>
                        <Text variant="body" weight="500" numberOfLines={1}>
                          {r.vendor || 'Receipt'}
                        </Text>
                        <Text variant="caption" color={t.colors.textMuted}>
                          {r.date ? formatDate(r.date, dateFmt) : 'No date'}
                        </Text>
                      </View>
                      <Text variant="body" weight="600" style={{ marginRight: t.spacing.sm }}>
                        {formatMoney(r.total, r.currency)}
                      </Text>
                      <IconButton
                        icon="chevron-forward"
                        color={t.colors.textMuted}
                        onPress={() => openReceipt(r.id)}
                        accessibilityLabel={`Open ${r.vendor || 'receipt'}`}
                      />
                    </Row>
                  </View>
                ))}
              </Card>
            </>
          )}

          {/* ---- TASK 82: Recurring / subscription charges ---- */}
          {insights.recurring.length > 0 ? (
            <>
              <SectionHeader title={`Recurring charges (${insights.recurring.length})`} />
              <Text variant="caption" color={t.colors.textMuted} style={{ marginBottom: t.spacing.sm }}>
                Repeating charges that look like subscriptions — cancel the ones
                you no longer use.
              </Text>
              <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
                {insights.recurring.map((rec, i) => (
                  <View key={`${rec.merchant}-${i}`}>
                    {i > 0 ? <Divider spacing={0} /> : null}
                    <Row align="center" style={{ paddingVertical: t.spacing.md }}>
                      <View style={{ flex: 1, paddingRight: t.spacing.md }}>
                        <Text variant="body" weight="500" numberOfLines={1}>
                          {rec.merchant || 'Merchant'}
                        </Text>
                        <Text variant="caption" color={t.colors.textMuted}>
                          {`${rec.count}× · ${cadenceLabel(rec.cadenceDays)}${
                            rec.lastDate ? ` · last ${formatDate(rec.lastDate, dateFmt)}` : ''
                          }`}
                        </Text>
                      </View>
                      <Text variant="body" weight="600">
                        {formatMoney(rec.amount, settings.default_currency)}
                      </Text>
                    </Row>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {/* ---- TASK 83: Duplicate / overcharge anomalies ---- */}
          {insights.anomalies.length > 0 ? (
            <>
              <SectionHeader title={`Possible billing errors (${insights.anomalies.length})`} />
              <Text variant="caption" color={t.colors.textMuted} style={{ marginBottom: t.spacing.sm }}>
                Likely double charges or tip/keying errors — worth a closer look.
              </Text>
              <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
                {insights.anomalies.map((an, i) => (
                  <View key={`${an.merchant}-${an.lineIndexes[0]}-${an.lineIndexes[1]}`}>
                    {i > 0 ? <Divider spacing={0} /> : null}
                    <Row align="center" style={{ paddingVertical: t.spacing.md }}>
                      <View
                        style={{
                          width: 36, height: 36, borderRadius: t.radius.md,
                          backgroundColor: t.colors.dangerTint,
                          alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <IconButton icon={an.kind === 'duplicate' ? 'copy-outline' : 'alert-circle-outline'} color={t.colors.danger} />
                      </View>
                      <View style={{ flex: 1, paddingHorizontal: t.spacing.md }}>
                        <Text variant="body" weight="500" numberOfLines={1}>
                          {(lineByIndex(an.lineIndexes[0])?.description) || an.merchant}
                        </Text>
                        <Text variant="caption" color={t.colors.textMuted}>
                          {an.reason}
                        </Text>
                      </View>
                      <Text variant="body" weight="600" color={t.colors.danger}>
                        {formatMoney(an.delta, settings.default_currency)}
                      </Text>
                    </Row>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {/* ---- TASK 85: Missing receipt / lost deduction nudges ---- */}
          {insights.missingDeductions.length > 0 ? (
            <>
              <SectionHeader title={`Possible lost deductions (${insights.missingDeductions.length})`} />
              <Text variant="caption" color={t.colors.textMuted} style={{ marginBottom: t.spacing.sm }}>
                Unmatched charges with no receipt — if any were business expenses,
                you may be missing a deduction. Scan or add the receipt to claim it.
              </Text>
              <Card padded={false} style={{ paddingHorizontal: t.spacing.lg }}>
                {insights.missingDeductions.map((nudge, i) => (
                  <View key={nudge.lineId}>
                    {i > 0 ? <Divider spacing={0} /> : null}
                    <Row align="center" style={{ paddingVertical: t.spacing.md }}>
                      <View
                        style={{
                          width: 36, height: 36, borderRadius: t.radius.md,
                          backgroundColor: t.colors.warningTint,
                          alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <IconButton icon="cash-outline" color={t.colors.warning} />
                      </View>
                      <View style={{ flex: 1, paddingHorizontal: t.spacing.md }}>
                        <Text variant="body" weight="500" numberOfLines={1}>
                          {nudge.description}
                        </Text>
                        <Text variant="caption" color={t.colors.textMuted}>
                          {nudge.date ? formatDate(nudge.date, dateFmt) : 'No date'}
                        </Text>
                      </View>
                      <Text variant="body" weight="600">
                        {formatMoney(nudge.amount, settings.default_currency)}
                      </Text>
                    </Row>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          <Spacer size={t.spacing.lg} />
          <Text variant="caption" color={t.colors.textMuted} align="center">
            CSV import only. ReceiptSnap never connects to your bank or stores any
            banking credentials.
          </Text>
        </>
      )}

      <LoadingOverlay visible={busy} message={busyMsg} />
    </Screen>
  );
}

/**
 * One matched row: statement line on the left, the receipt it pairs with on the
 * right, a confidence score, and a confirm/undo control. Tapping the receipt
 * info opens its detail. We render BOTH amounts so a near-match (different cents,
 * which the matcher tolerates) is obvious to the user.
 */
function MatchedRowView({
  row,
  dateFmt,
  onConfirm,
  onClear,
  onOpenReceipt,
}: {
  row: MatchedRow;
  dateFmt: string;
  onConfirm: () => void;
  onClear: () => void;
  onOpenReceipt: () => void;
}) {
  const t = useTheme();
  const { line, receipt, score, confirmed } = row;
  // Score buckets reuse the confidence palette so the UI reads consistently.
  const scoreColor =
    score >= 0.85 ? t.colors.confHigh : score >= 0.6 ? t.colors.confMedium : t.colors.confLow;
  const pct = `${Math.round(score * 100)}%`;

  return (
    <View style={{ paddingVertical: t.spacing.md, gap: t.spacing.sm }}>
      <Row justify="space-between" align="flex-start">
        {/* Statement side */}
        <View style={{ flex: 1, paddingRight: t.spacing.sm }}>
          <Text variant="caption" color={t.colors.textMuted}>
            STATEMENT
          </Text>
          <Text variant="body" weight="500" numberOfLines={1}>
            {line.description || 'Charge'}
          </Text>
          <Text variant="caption" color={t.colors.textMuted}>
            {`${line.date ? formatDate(line.date, dateFmt) : 'No date'} · ${formatMoney(
              line.amount,
              receipt.currency,
            )}`}
          </Text>
        </View>

        <Badge
          label={confirmed ? 'Confirmed' : `Match ${pct}`}
          icon={confirmed ? 'checkmark-circle' : 'git-compare-outline'}
          color={confirmed ? t.colors.success : scoreColor}
          background={confirmed ? t.colors.successTint : t.colors.surfaceAlt}
        />
      </Row>

      {/* Receipt side — tappable to open the detail screen. */}
      <Card onPress={onOpenReceipt} style={{ backgroundColor: t.colors.surfaceAlt }}>
        <Row justify="space-between" align="center">
          <View style={{ flex: 1, paddingRight: t.spacing.sm }}>
            <Text variant="caption" color={t.colors.textMuted}>
              RECEIPT
            </Text>
            <Text variant="body" weight="500" numberOfLines={1}>
              {receipt.vendor || 'Receipt'}
            </Text>
            <Text variant="caption" color={t.colors.textMuted}>
              {`${receipt.date ? formatDate(receipt.date, dateFmt) : 'No date'} · ${formatMoney(
                receipt.total,
                receipt.currency,
              )}`}
            </Text>
          </View>
          <IconButton icon="chevron-forward" color={t.colors.textMuted} onPress={onOpenReceipt} />
        </Row>
      </Card>

      {/* Confirm / undo the match. */}
      {confirmed ? (
        <Button title="Undo match" icon="close" variant="ghost" size="sm" onPress={onClear} />
      ) : (
        <Button title="Confirm match" icon="checkmark" variant="success" size="sm" onPress={onConfirm} />
      )}
    </View>
  );
}
