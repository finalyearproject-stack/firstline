/**
 * Where villages sit: district > sub-county > parish > village.
 *
 * Patients and visits record a village name; the `locations` table places that name in
 * the hierarchy. Every list that can be narrowed by place uses `locationClause`, so the
 * filter means the same thing on every page.
 */
import { z } from 'zod';
import type { LocationFilter } from '@rhm/shared';
import type { Db, Param } from '../db/index.ts';

const name = z.string().trim().min(1).max(120);

/** Query-string filters. Empty strings are treated as "not set". */
export const locationFilterSchema = z.object({
  district: name.optional().catch(undefined),
  subCounty: name.optional().catch(undefined),
  parish: name.optional().catch(undefined),
  village: name.optional().catch(undefined),
});

export const locationSchema = z.object({
  village: name,
  parish: name,
  subCounty: name,
  district: name,
});

export interface LocationRow {
  village: string;
  parish: string;
  subCounty: string;
  district: string;
}

/**
 * SQL that keeps only rows whose village column falls inside the filter.
 *
 * `column` is the village column of the row being filtered (e.g. `p.village`). The
 * hierarchy levels go through a sub-select on `locations`, so a village that has not
 * been placed yet only matches a filter on its own name.
 */
export function locationClause(column: string, filter: LocationFilter): { sql: string[]; params: Param[] } {
  const sql: string[] = [];
  const params: Param[] = [];

  if (filter.village) {
    sql.push(`${column} = ?`);
    params.push(filter.village);
  }

  const levels: string[] = [];
  const levelParams: Param[] = [];
  if (filter.district) { levels.push('district = ?'); levelParams.push(filter.district); }
  if (filter.subCounty) { levels.push('sub_county = ?'); levelParams.push(filter.subCounty); }
  if (filter.parish) { levels.push('parish = ?'); levelParams.push(filter.parish); }
  if (levels.length > 0) {
    sql.push(`${column} IN (SELECT village FROM locations WHERE ${levels.join(' AND ')})`);
    params.push(...levelParams);
  }

  return { sql, params };
}

function mapLocation(row: Record<string, unknown>): LocationRow {
  return {
    village: String(row.village),
    parish: String(row.parish),
    subCounty: String(row.sub_county),
    district: String(row.district),
  };
}

/**
 * Every placed village, plus the village names in use that nobody has placed yet, so an
 * administrator can see what still needs a parish.
 */
export async function listLocations(db: Db): Promise<{ locations: LocationRow[]; unplaced: string[] }> {
  const [rows, unplaced] = await Promise.all([
    db.all<Record<string, unknown>>(
      'SELECT * FROM locations ORDER BY district, sub_county, parish, village',
    ),
    db.all<{ village: string }>(
      'SELECT DISTINCT village FROM patients WHERE village NOT IN (SELECT village FROM locations) ORDER BY village',
    ),
  ]);
  return { locations: rows.map(mapLocation), unplaced: unplaced.map((row) => row.village) };
}

/** Places a village, or moves it to a different parish. */
export async function saveLocation(db: Db, input: LocationRow): Promise<LocationRow> {
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO locations (village, parish, sub_county, district, created_at, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT (village) DO UPDATE SET parish = excluded.parish, sub_county = excluded.sub_county,' +
      ' district = excluded.district, updated_at = excluded.updated_at',
    [input.village, input.parish, input.subCounty, input.district, now, now],
  );
  return input;
}

/** Looks up the place of each village name in one query. */
export async function placesOf(db: Db, villages: string[]): Promise<Map<string, LocationRow>> {
  const unique = [...new Set(villages)];
  if (unique.length === 0) return new Map();
  const rows = await db.all<Record<string, unknown>>(
    `SELECT * FROM locations WHERE village IN (${unique.map(() => '?').join(', ')})`,
    unique,
  );
  return new Map(rows.map((row) => [String(row.village), mapLocation(row)]));
}
