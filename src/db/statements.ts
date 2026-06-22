/** Statement import + line DAOs (CSV bank/card statement matching). */
import { getDb } from './database';
import { mapStatementImport, mapStatementLine } from './mappers';
import { newId } from '../lib/id';
import type { StatementImport, StatementLine } from '../types';

export async function createImport(
  filename: string,
  lines: Omit<StatementLine, 'id' | 'import_id'>[],
): Promise<StatementImport> {
  const db = await getDb();
  const importId = newId();
  const importedAt = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'INSERT INTO statement_imports (id, filename, imported_at, line_count) VALUES (?,?,?,?)',
      [importId, filename, importedAt, lines.length],
    );
    for (const l of lines) {
      await db.runAsync(
        `INSERT INTO statement_lines (id, import_id, date, amount, description, matched_receipt_id, match_score)
         VALUES (?,?,?,?,?,?,?)`,
        [
          newId(),
          importId,
          l.date ?? null,
          l.amount,
          l.description,
          l.matched_receipt_id ?? null,
          l.match_score ?? 0,
        ],
      );
    }
  });
  return {
    id: importId,
    filename,
    imported_at: importedAt,
    line_count: lines.length,
  };
}

export async function listImports(): Promise<StatementImport[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM statement_imports ORDER BY imported_at DESC',
  );
  return rows.map(mapStatementImport);
}

export async function listLines(importId: string): Promise<StatementLine[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM statement_lines WHERE import_id = ? ORDER BY date ASC',
    [importId],
  );
  return rows.map(mapStatementLine);
}

export async function listAllLines(): Promise<StatementLine[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM statement_lines ORDER BY date ASC',
  );
  return rows.map(mapStatementLine);
}

export async function setLineMatch(
  lineId: string,
  receiptId: string | null,
  score: number,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE statement_lines SET matched_receipt_id = ?, match_score = ? WHERE id = ?',
    [receiptId, score, lineId],
  );
}

export async function deleteImport(importId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM statement_imports WHERE id = ?', [importId]);
}
