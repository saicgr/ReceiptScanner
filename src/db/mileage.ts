/** Mileage trip DAO. Trips contribute to reports/categories like receipts. */
import { getDb, toInt } from './database';
import { mapMileageTrip } from './mappers';
import { newId } from '../lib/id';
import type { MileageTrip } from '../types';

const NOW = () => new Date().toISOString();

export async function listTrips(): Promise<MileageTrip[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    'SELECT * FROM mileage_trips ORDER BY start_time DESC',
  );
  return rows.map(mapMileageTrip);
}

export async function getTrip(id: string): Promise<MileageTrip | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    'SELECT * FROM mileage_trips WHERE id = ?',
    [id],
  );
  return row ? mapMileageTrip(row) : null;
}

export async function createTrip(
  input: Partial<MileageTrip>,
): Promise<MileageTrip> {
  const db = await getDb();
  const id = input.id ?? newId();
  const distance = input.distance_miles ?? 0;
  const rate = input.rate_per_mile ?? 0;
  await db.runAsync(
    `INSERT INTO mileage_trips (
      id, start_time, end_time, distance_miles, rate_per_mile, amount,
      category_id, tax_category_id, memo, is_manual, path_json, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.start_time ?? NOW(),
      input.end_time ?? null,
      distance,
      rate,
      input.amount ?? round2(distance * rate),
      input.category_id ?? null,
      input.tax_category_id ?? null,
      input.memo ?? '',
      toInt(input.is_manual ?? false),
      input.path_json ?? null,
      input.created_at ?? NOW(),
    ],
  );
  return (await getTrip(id))!;
}

export async function updateTrip(
  id: string,
  patch: Partial<MileageTrip>,
): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const params: any[] = [];
  const cols = [
    'start_time',
    'end_time',
    'distance_miles',
    'rate_per_mile',
    'amount',
    'category_id',
    'tax_category_id',
    'memo',
    'path_json',
  ] as const;
  for (const k of cols) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      params.push(patch[k] as any);
    }
  }
  if (patch.is_manual !== undefined) {
    fields.push('is_manual = ?');
    params.push(toInt(patch.is_manual));
  }
  // Keep amount consistent if distance/rate changed but amount wasn't supplied.
  if (
    (patch.distance_miles !== undefined || patch.rate_per_mile !== undefined) &&
    patch.amount === undefined
  ) {
    const cur = await getTrip(id);
    if (cur) {
      const dist = patch.distance_miles ?? cur.distance_miles;
      const rate = patch.rate_per_mile ?? cur.rate_per_mile;
      fields.push('amount = ?');
      params.push(round2(dist * rate));
    }
  }
  if (!fields.length) return;
  params.push(id);
  await db.runAsync(
    `UPDATE mileage_trips SET ${fields.join(', ')} WHERE id = ?`,
    params,
  );
}

export async function deleteTrip(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM mileage_trips WHERE id = ?', [id]);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
