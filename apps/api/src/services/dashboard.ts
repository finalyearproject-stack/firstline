/**
 * Dashboard analytics (spec s14/s15).
 *
 * Every query in this module returns AGGREGATE data only — counts, rates and trends.
 * No function here selects a patient name, phone number or clinical detail. That is
 * the mechanism behind the privacy requirement in spec s18: officials cannot
 * accidentally be shown identifiable data because the queries that serve them cannot
 * produce it.
 *
 * Timestamps are stored as ISO-8601 text, which sorts lexicographically, so range
 * filters and `substr(ts, 1, 10)` day-grouping behave identically in SQLite and
 * PostgreSQL without dialect branching.
 */
import type { Db, Param } from '../db/index.ts';

export interface DateRange {
  from: string;
  to: string;
}

/** Defaults to the trailing 30 days, which is the window the CHW workflow is built around. */
export function defaultRange(days = 30): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

interface Filters extends DateRange {
  village?: string | null;
}

function villageClause(village: string | null | undefined, column: string): { sql: string; params: Param[] } {
  if (!village) return { sql: '', params: [] };
  return { sql: ` AND ${column} = ?`, params: [village] };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface Overview {
  totalPatients: number;
  totalVisits: number;
  activeChws: number;
  redAlerts: number;
  amberAlerts: number;
  greenScreenings: number;
  pendingFollowUps: number;
  pendingReferrals: number;
  /** Records the server has not received; reported by clients, see syncHealth(). */
  unsyncedRecords: number;
  range: DateRange;
  /**
   * The same period-scoped counts for the window of equal length immediately before
   * `range`, so the dashboard can show a like-for-like change.
   *
   * Pending referrals and open follow-ups are deliberately absent: they are point-in-time
   * backlogs, not counts over a period, and a "change vs previous period" for them would
   * compare two different kinds of number.
   */
  previous: PeriodCounts;
}

export interface PeriodCounts {
  totalPatients: number;
  totalVisits: number;
  activeChws: number;
  redAlerts: number;
  amberAlerts: number;
  greenScreenings: number;
}

/** Counts that belong to a time window. Used for both the current and previous windows. */
async function periodCounts(db: Db, from: string, to: string, village: string | null | undefined): Promise<PeriodCounts> {
  const v = villageClause(village, 'village');
  const range: Param[] = [from, to];

  const [patients, visits, chws, triage] = await Promise.all([
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM patients WHERE created_at BETWEEN ? AND ?${v.sql}`,
      [...range, ...v.params],
    ),
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM visits WHERE visit_date BETWEEN ? AND ?${v.sql}`,
      [...range, ...v.params],
    ),
    db.get<{ n: number }>(
      'SELECT COUNT(DISTINCT chw_id) AS n FROM visits WHERE visit_date BETWEEN ? AND ?' +
        (village ? ' AND village = ?' : ''),
      [...range, ...v.params],
    ),
    db.all<{ risk_level: string; n: number }>(
      'SELECT t.risk_level, COUNT(*) AS n FROM triage_results t' +
        ' JOIN visits vi ON vi.id = t.visit_id' +
        ` WHERE t.created_at BETWEEN ? AND ?${village ? ' AND vi.village = ?' : ''}` +
        ' GROUP BY t.risk_level',
      [...range, ...v.params],
    ),
  ]);

  const byRisk = Object.fromEntries(triage.map((r) => [r.risk_level, Number(r.n)]));

  return {
    totalPatients: Number(patients?.n ?? 0),
    totalVisits: Number(visits?.n ?? 0),
    activeChws: Number(chws?.n ?? 0),
    redAlerts: byRisk.RED ?? 0,
    amberAlerts: byRisk.AMBER ?? 0,
    greenScreenings: byRisk.GREEN ?? 0,
  };
}

/** The window of equal length ending where `range` starts. */
export function previousRange(range: DateRange): DateRange {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  return { from: new Date(from - (to - from)).toISOString(), to: new Date(from).toISOString() };
}

export async function getOverview(db: Db, filters: Filters): Promise<Overview> {
  const before = previousRange(filters);

  const [current, previous, followUps, referrals] = await Promise.all([
    periodCounts(db, filters.from, filters.to, filters.village),
    periodCounts(db, before.from, before.to, filters.village),
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM referrals WHERE follow_up_date IS NOT NULL" +
        " AND status IN ('PENDING','ACKNOWLEDGED')",
    ),
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM referrals WHERE status = 'PENDING'"),
  ]);

  return {
    ...current,
    pendingFollowUps: Number(followUps?.n ?? 0),
    pendingReferrals: Number(referrals?.n ?? 0),
    unsyncedRecords: 0,
    range: { from: filters.from, to: filters.to },
    previous,
  };
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

export interface TriagePoint {
  date: string;
  RED: number;
  AMBER: number;
  GREEN: number;
}

export async function getTriageTrend(db: Db, filters: Filters): Promise<TriagePoint[]> {
  const rows = await db.all<{ day: string; risk_level: string; n: number }>(
    'SELECT substr(t.created_at, 1, 10) AS day, t.risk_level, COUNT(*) AS n' +
      ' FROM triage_results t JOIN visits vi ON vi.id = t.visit_id' +
      ` WHERE t.created_at BETWEEN ? AND ?${filters.village ? ' AND vi.village = ?' : ''}` +
      ' GROUP BY day, t.risk_level ORDER BY day',
    [filters.from, filters.to, ...(filters.village ? [filters.village] : [])],
  );

  const byDay = new Map<string, TriagePoint>();
  for (const row of rows) {
    const point = byDay.get(row.day) ?? { date: row.day, RED: 0, AMBER: 0, GREEN: 0 };
    point[row.risk_level as 'RED' | 'AMBER' | 'GREEN'] = Number(row.n);
    byDay.set(row.day, point);
  }
  return [...byDay.values()];
}

export interface VillageStat {
  village: string;
  patients: number;
  visits: number;
  red: number;
  amber: number;
  green: number;
  referrals: number;
  /** Share of screenings flagged RED, as a percentage; the headline risk signal. */
  redRate: number;
}

export async function getVillageStats(db: Db, filters: DateRange): Promise<VillageStat[]> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT vi.village AS village,' +
      ' COUNT(DISTINCT vi.patient_id) AS patients,' +
      ' COUNT(DISTINCT vi.id) AS visits,' +
      " SUM(CASE WHEN t.risk_level = 'RED'   THEN 1 ELSE 0 END) AS red," +
      " SUM(CASE WHEN t.risk_level = 'AMBER' THEN 1 ELSE 0 END) AS amber," +
      " SUM(CASE WHEN t.risk_level = 'GREEN' THEN 1 ELSE 0 END) AS green," +
      ' COUNT(DISTINCT r.id) AS referrals' +
      ' FROM visits vi' +
      ' LEFT JOIN triage_results t ON t.visit_id = vi.id' +
      ' LEFT JOIN referrals r ON r.visit_id = vi.id' +
      ' WHERE vi.visit_date BETWEEN ? AND ?' +
      ' GROUP BY vi.village ORDER BY red DESC, visits DESC',
    [filters.from, filters.to],
  );

  return rows.map((row) => {
    const red = Number(row.red ?? 0);
    const amber = Number(row.amber ?? 0);
    const green = Number(row.green ?? 0);
    const screened = red + amber + green;
    return {
      village: String(row.village),
      patients: Number(row.patients ?? 0),
      visits: Number(row.visits ?? 0),
      red,
      amber,
      green,
      referrals: Number(row.referrals ?? 0),
      redRate: screened > 0 ? Math.round((red / screened) * 1000) / 10 : 0,
    };
  });
}

export interface ChwActivity {
  chwId: string;
  name: string;
  chwIdentifier: string | null;
  village: string | null;
  visits: number;
  patients: number;
  red: number;
  referrals: number;
  lastVisitAt: string | null;
  /** Hours since the CHW's most recent upload; drives the sync-failure alert. */
  hoursSinceLastSync: number | null;
}

export async function getChwActivity(db: Db, filters: DateRange): Promise<ChwActivity[]> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT u.id AS chw_id, u.name, u.chw_identifier, u.village,' +
      ' COUNT(DISTINCT vi.id) AS visits,' +
      ' COUNT(DISTINCT vi.patient_id) AS patients,' +
      " SUM(CASE WHEN t.risk_level = 'RED' THEN 1 ELSE 0 END) AS red," +
      ' COUNT(DISTINCT r.id) AS referrals,' +
      ' MAX(vi.visit_date) AS last_visit,' +
      ' (SELECT MAX(received_at) FROM sync_receipts sr WHERE sr.user_id = u.id) AS last_sync' +
      ' FROM users u' +
      ' LEFT JOIN visits vi ON vi.chw_id = u.id AND vi.visit_date BETWEEN ? AND ?' +
      ' LEFT JOIN triage_results t ON t.visit_id = vi.id' +
      ' LEFT JOIN referrals r ON r.visit_id = vi.id' +
      " WHERE u.role = 'CHW' AND u.status = 'ACTIVE'" +
      ' GROUP BY u.id, u.name, u.chw_identifier, u.village' +
      ' ORDER BY visits DESC',
    [filters.from, filters.to],
  );

  const now = Date.now();
  return rows.map((row) => {
    const lastSync = row.last_sync ? String(row.last_sync) : null;
    return {
      chwId: String(row.chw_id),
      name: String(row.name),
      chwIdentifier: row.chw_identifier ? String(row.chw_identifier) : null,
      village: row.village ? String(row.village) : null,
      visits: Number(row.visits ?? 0),
      patients: Number(row.patients ?? 0),
      red: Number(row.red ?? 0),
      referrals: Number(row.referrals ?? 0),
      lastVisitAt: row.last_visit ? String(row.last_visit) : null,
      hoursSinceLastSync: lastSync
        ? Math.round(((now - Date.parse(lastSync)) / 3_600_000) * 10) / 10
        : null,
    };
  });
}

export interface ReferralStats {
  byStatus: Record<string, number>;
  byUrgency: Record<string, number>;
  trend: Array<{ date: string; created: number; completed: number }>;
  /** Median hours from referral creation to completion, where completed. */
  medianCompletionHours: number | null;
}

export async function getReferralStats(db: Db, filters: DateRange): Promise<ReferralStats> {
  const [statuses, urgencies, created, completed, durations] = await Promise.all([
    db.all<{ status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM referrals WHERE created_at BETWEEN ? AND ? GROUP BY status',
      [filters.from, filters.to],
    ),
    db.all<{ urgency: string; n: number }>(
      'SELECT urgency, COUNT(*) AS n FROM referrals WHERE created_at BETWEEN ? AND ? GROUP BY urgency',
      [filters.from, filters.to],
    ),
    db.all<{ day: string; n: number }>(
      'SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM referrals' +
        ' WHERE created_at BETWEEN ? AND ? GROUP BY day ORDER BY day',
      [filters.from, filters.to],
    ),
    db.all<{ day: string; n: number }>(
      'SELECT substr(completed_at, 1, 10) AS day, COUNT(*) AS n FROM referrals' +
        ' WHERE completed_at IS NOT NULL AND completed_at BETWEEN ? AND ? GROUP BY day ORDER BY day',
      [filters.from, filters.to],
    ),
    db.all<{ created_at: string; completed_at: string }>(
      'SELECT created_at, completed_at FROM referrals' +
        ' WHERE completed_at IS NOT NULL AND created_at BETWEEN ? AND ?',
      [filters.from, filters.to],
    ),
  ]);

  const completedByDay = new Map(completed.map((r) => [r.day, Number(r.n)]));
  const days = new Set([...created.map((r) => r.day), ...completed.map((r) => r.day)]);

  const hours = durations
    .map((r) => (Date.parse(r.completed_at) - Date.parse(r.created_at)) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);

  return {
    byStatus: Object.fromEntries(statuses.map((r) => [r.status, Number(r.n)])),
    byUrgency: Object.fromEntries(urgencies.map((r) => [r.urgency, Number(r.n)])),
    trend: [...days].sort().map((day) => ({
      date: day,
      created: Number(created.find((r) => r.day === day)?.n ?? 0),
      completed: completedByDay.get(day) ?? 0,
    })),
    medianCompletionHours: hours.length
      ? Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10
      : null,
  };
}

export async function getScreeningVolume(
  db: Db,
  filters: DateRange,
): Promise<Array<{ date: string; visits: number }>> {
  const rows = await db.all<{ day: string; n: number }>(
    'SELECT substr(visit_date, 1, 10) AS day, COUNT(*) AS n FROM visits' +
      ' WHERE visit_date BETWEEN ? AND ? GROUP BY day ORDER BY day',
    [filters.from, filters.to],
  );
  return rows.map((r) => ({ date: r.day, visits: Number(r.n) }));
}

export async function getRiskByCategory(
  db: Db,
  filters: DateRange,
): Promise<Array<{ category: string; count: number }>> {
  // The rule id prefix encodes the clinical category (HTN-, DM-, MAT-...), so the
  // breakdown can be derived without a second lookup table.
  const rows = await db.all<{ triggered_rules: string }>(
    'SELECT triggered_rules FROM triage_results WHERE created_at BETWEEN ? AND ?',
    [filters.from, filters.to],
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    let ruleIds: string[] = [];
    try {
      ruleIds = JSON.parse(row.triggered_rules) as string[];
    } catch {
      continue;
    }
    for (const id of ruleIds) {
      const category = id.split('-')[0] ?? 'OTHER';
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Sync monitoring and alerts
// ---------------------------------------------------------------------------

export interface SyncHealth {
  receiptsLast24h: number;
  rejectedLast24h: number;
  conflictsLast24h: number;
  chwsSilentOver48h: Array<{ chwId: string; name: string; hoursSinceLastSync: number | null }>;
}

export async function getSyncHealth(db: Db): Promise<SyncHealth> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [counts, activity] = await Promise.all([
    db.all<{ result_status: string; n: number }>(
      'SELECT result_status, COUNT(*) AS n FROM sync_receipts WHERE received_at >= ? GROUP BY result_status',
      [since],
    ),
    getChwActivity(db, defaultRange(30)),
  ]);

  const byStatus = Object.fromEntries(counts.map((r) => [r.result_status, Number(r.n)]));

  return {
    receiptsLast24h: Object.values(byStatus).reduce((a, b) => a + b, 0),
    rejectedLast24h: byStatus.REJECTED ?? 0,
    conflictsLast24h: byStatus.CONFLICT ?? 0,
    chwsSilentOver48h: activity
      .filter((c) => c.hoursSinceLastSync === null || c.hoursSinceLastSync > 48)
      .map((c) => ({ chwId: c.chwId, name: c.name, hoursSinceLastSync: c.hoursSinceLastSync })),
  };
}

export interface Alert {
  id: string;
  severity: 'HIGH' | 'MEDIUM' | 'INFO';
  title: string;
  detail: string;
  category: 'CLINICAL' | 'OPERATIONAL' | 'SYNC';
}

/**
 * Derived alerts (spec s15).
 *
 * Thresholds are intentionally simple and explicit. An alert that nobody can explain
 * is an alert nobody acts on.
 */
export async function getAlerts(db: Db): Promise<Alert[]> {
  const month = defaultRange(30);
  const [villages, referrals, sync] = await Promise.all([
    getVillageStats(db, month),
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM referrals WHERE status = 'PENDING'",
    ),
    getSyncHealth(db),
  ]);

  const alerts: Alert[] = [];

  for (const village of villages) {
    if (village.red >= 4) {
      alerts.push({
        id: `red-cluster-${village.village}`,
        severity: 'HIGH',
        title: `${village.village} — ${village.red} RED flags this month`,
        detail:
          `${village.red} of ${village.red + village.amber + village.green} screenings in ` +
          `${village.village} were flagged RED (${village.redRate}%). Review the referrals for this village.`,
        category: 'CLINICAL',
      });
    }
  }

  const pending = Number(referrals?.n ?? 0);
  if (pending >= 10) {
    alerts.push({
      id: 'referrals-pending',
      severity: pending >= 25 ? 'HIGH' : 'MEDIUM',
      title: `${pending} referrals pending follow-up`,
      detail: 'These referrals have been created but not yet acknowledged by a facility.',
      category: 'OPERATIONAL',
    });
  }

  if (sync.chwsSilentOver48h.length > 0) {
    alerts.push({
      id: 'sync-silent',
      severity: 'MEDIUM',
      title: `${sync.chwsSilentOver48h.length} CHW(s) have not synchronised in 48 hours`,
      detail:
        'Their records are still safe on their devices. Check whether they have network access. ' +
        sync.chwsSilentOver48h.map((c) => c.name).join(', '),
      category: 'SYNC',
    });
  }

  if (sync.rejectedLast24h > 0) {
    alerts.push({
      id: 'sync-rejected',
      severity: 'MEDIUM',
      title: `${sync.rejectedLast24h} record(s) rejected during synchronisation`,
      detail: 'Review the audit log to see which records failed validation.',
      category: 'SYNC',
    });
  }

  const busiest = [...villages].sort((a, b) => b.visits - a.visits)[0];
  if (busiest && busiest.visits >= 20) {
    alerts.push({
      id: `activity-${busiest.village}`,
      severity: 'INFO',
      title: `Increased screening activity in ${busiest.village}`,
      detail: `${busiest.visits} visits recorded in the last 30 days.`,
      category: 'OPERATIONAL',
    });
  }

  const order = { HIGH: 0, MEDIUM: 1, INFO: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------------------------------------------------------------------------
// Symptom trends (district surveillance)
// ---------------------------------------------------------------------------

/**
 * What a district health official actually asks: "what is going up, and where?"
 *
 * This reports SYMPTOMS, not illnesses, and the distinction is deliberate rather than
 * a limitation. The system never records a diagnosis, so it cannot report one. What it
 * holds is what a CHW observed — cough, fever, swelling — and reporting that honestly is
 * more useful to a district officer than a disease label nobody qualified assigned.
 *
 * Every query here is aggregate-only, consistent with the rest of this module.
 */

/**
 * A symptom must reach this many occurrences in the current window before the trend
 * label will call it RISING or FALLING. Without a floor, two cases becoming three reads
 * as "+50%", and a district officer chases noise. The percentage is still reported; only
 * the label is withheld.
 */
const TREND_SIGNAL_FLOOR = 5;

/**
 * Percentage change needed to be called a movement rather than ordinary variation.
 * Screening volume itself fluctuates with how many days a CHW worked, so a small
 * swing in raw counts usually says more about the CHW's week than the village's health.
 */
const TREND_MOVEMENT_PCT = 25;

/**
 * Village-level counts below this are withheld. An official is authorised to see their
 * own district's data, but a rare symptom in a small village can single out one
 * household, and the district total does not require that resolution to be actionable.
 */
const VILLAGE_MIN_CELL = 5;

export type TrendDirection = 'RISING' | 'FALLING' | 'STEADY' | 'NEW';

export interface SymptomTrend {
  symptomCode: string;
  symptomName: string;
  /** Occurrences inside the requested window. */
  current: number;
  /** Occurrences in the immediately preceding window of equal length. */
  previous: number;
  /** Null when there is no prior baseline to divide by. */
  changePct: number | null;
  direction: TrendDirection;
  /** Share of this symptom's occurrences recorded as SEVERE, 0-1. */
  severeShare: number;
  /** Share whose visit triaged RED, 0-1. Separates "common" from "serious". */
  redShare: number;
  /** Villages carrying this symptom, suppressed below the minimum cell size. */
  villages: Array<{ village: string; count: number }>;
  /** Villages omitted from the list above because they fell under the threshold. */
  villagesSuppressed: number;
}

interface SymptomRow {
  symptom_code: string;
  symptom_name: string;
  severity: string;
  village: string;
  risk_level: string | null;
}

/** Occurrences joined to their visit's village and triage outcome, for one window. */
async function symptomRows(db: Db, from: string, to: string, village?: string | null): Promise<SymptomRow[]> {
  const v = villageClause(village, 'v.village');
  return db.all<SymptomRow>(
    'SELECT s.symptom_code, s.symptom_name, s.severity, v.village, t.risk_level' +
      ' FROM symptoms s' +
      ' JOIN visits v ON v.id = s.visit_id' +
      ' LEFT JOIN triage_results t ON t.visit_id = s.visit_id' +
      ' WHERE v.visit_date BETWEEN ? AND ?' +
      v.sql,
    [from, to, ...v.params],
  );
}

function direction(current: number, previous: number, changePct: number | null): TrendDirection {
  if (previous === 0) return current > 0 ? 'NEW' : 'STEADY';
  if (current < TREND_SIGNAL_FLOOR) return 'STEADY';
  if (changePct === null) return 'STEADY';
  if (changePct >= TREND_MOVEMENT_PCT) return 'RISING';
  if (changePct <= -TREND_MOVEMENT_PCT) return 'FALLING';
  return 'STEADY';
}

export async function getSymptomTrends(db: Db, filters: Filters): Promise<SymptomTrend[]> {
  // The comparison window is the same length as the requested one, immediately before it,
  // so "rising" always means "against a like-for-like period" rather than against an
  // arbitrary baseline.
  const span = Date.parse(filters.to) - Date.parse(filters.from);
  const prevTo = filters.from;
  const prevFrom = new Date(Date.parse(filters.from) - span).toISOString();

  const [now, before] = await Promise.all([
    symptomRows(db, filters.from, filters.to, filters.village),
    symptomRows(db, prevFrom, prevTo, filters.village),
  ]);

  const previousCounts = new Map<string, number>();
  for (const r of before) {
    previousCounts.set(r.symptom_code, (previousCounts.get(r.symptom_code) ?? 0) + 1);
  }

  interface Acc {
    name: string;
    total: number;
    severe: number;
    red: number;
    villages: Map<string, number>;
  }
  const acc = new Map<string, Acc>();

  for (const r of now) {
    let entry = acc.get(r.symptom_code);
    if (!entry) {
      entry = { name: r.symptom_name, total: 0, severe: 0, red: 0, villages: new Map() };
      acc.set(r.symptom_code, entry);
    }
    entry.total += 1;
    if (r.severity === 'SEVERE') entry.severe += 1;
    if (r.risk_level === 'RED') entry.red += 1;
    entry.villages.set(r.village, (entry.villages.get(r.village) ?? 0) + 1);
  }

  const trends: SymptomTrend[] = [];
  for (const [code, entry] of acc) {
    const previous = previousCounts.get(code) ?? 0;
    const changePct = previous === 0
      ? null
      : Math.round(((entry.total - previous) / previous) * 1000) / 10;

    const villages = [...entry.villages.entries()]
      .filter(([, n]) => n >= VILLAGE_MIN_CELL)
      .map(([village, count]) => ({ village, count }))
      .sort((a, b) => b.count - a.count);

    trends.push({
      symptomCode: code,
      symptomName: entry.name,
      current: entry.total,
      previous,
      changePct,
      direction: direction(entry.total, previous, changePct),
      severeShare: entry.total === 0 ? 0 : Math.round((entry.severe / entry.total) * 100) / 100,
      redShare: entry.total === 0 ? 0 : Math.round((entry.red / entry.total) * 100) / 100,
      villages,
      villagesSuppressed: entry.villages.size - villages.length,
    });
  }

  // Most frequent first: a district officer reads the top of this list and stops.
  return trends.sort((a, b) => b.current - a.current);
}
