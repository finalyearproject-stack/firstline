/**
 * Row mappers and persistence for the clinical entities.
 *
 * The database uses snake_case, the domain uses camelCase; the mapping is done once
 * here so no other module has to know a column name. Every write is an upsert keyed on
 * the client-generated UUID, which is what makes a replayed sync harmless.
 */
import type {
  ConsentStatus,
  MuacColour,
  Patient,
  RdtResult,
  Referral,
  ReferralStatus,
  RiskLevel,
  ScreeningFocus,
  Severity,
  Sex,
  Symptom,
  TriageResult,
  Urgency,
  User,
  Visit,
  VitalSigns,
} from '@rhm/shared';
import { fromBool, parseJson, toBool, type Db, type Row } from '../db/index.ts';

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function mapUser(row: Row): User {
  return {
    id: row.id as string,
    name: row.name as string,
    phone: (row.phone as string) ?? null,
    username: row.username as string,
    role: row.role as User['role'],
    chwIdentifier: (row.chw_identifier as string) ?? null,
    village: (row.village as string) ?? null,
    status: row.status as User['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function mapPatient(row: Row): Patient {
  return {
    id: row.id as string,
    // Once a row exists on the server, its server identity is its UUID: there is only
    // ever one identifier for a patient, which is what removes the whole class of
    // local-id/server-id reconciliation bugs.
    serverId: row.id as string,
    localId: row.local_id as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    age: Number(row.age),
    sex: row.sex as Sex,
    village: row.village as string,
    phone: (row.phone as string) ?? null,
    consentStatus: row.consent_status as ConsentStatus,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    version: Number(row.version),
    syncStatus: 'SYNCED',
  };
}

export function mapVisit(row: Row): Visit {
  return {
    id: row.id as string,
    patientId: row.patient_id as string,
    chwId: row.chw_id as string,
    visitDate: row.visit_date as string,
    village: row.village as string,
    notes: (row.notes as string) ?? null,
    focus: (row.focus as ScreeningFocus) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    version: Number(row.version),
    syncStatus: 'SYNCED',
  };
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mapVitals(row: Row): VitalSigns {
  return {
    id: row.id as string,
    visitId: row.visit_id as string,
    systolicBp: num(row.systolic_bp),
    diastolicBp: num(row.diastolic_bp),
    temperatureC: num(row.temperature_c),
    weightKg: num(row.weight_kg),
    pulseBpm: num(row.pulse_bpm),
    oxygenSaturation: num(row.oxygen_saturation),
    respiratoryRate: num(row.respiratory_rate),
    bloodGlucoseMmol: num(row.blood_glucose_mmol),
    muacColour: (row.muac_colour as MuacColour) ?? null,
    malariaRdt: (row.malaria_rdt as RdtResult) ?? null,
    oedema: row.oedema === null || row.oedema === undefined ? null : toBool(row.oedema),
    pregnancyWeeks: num(row.pregnancy_weeks),
    recordedAt: row.recorded_at as string,
    syncStatus: 'SYNCED',
  };
}

export function mapSymptom(row: Row): Symptom {
  return {
    id: row.id as string,
    visitId: row.visit_id as string,
    symptomCode: row.symptom_code as string,
    symptomName: row.symptom_name as string,
    severity: row.severity as Severity,
    durationDays: num(row.duration_days),
    syncStatus: 'SYNCED',
  };
}

export function mapTriage(row: Row): TriageResult {
  return {
    id: row.id as string,
    visitId: row.visit_id as string,
    riskLevel: row.risk_level as RiskLevel,
    triggeredRules: parseJson<string[]>(row.triggered_rules, []),
    triggeredLabels: parseJson<string[]>(row.triggered_labels, []),
    recommendation: row.recommendation as string,
    referralRequired: toBool(row.referral_required),
    rulesetVersion: row.ruleset_version as string,
    evaluationMs: Number(row.evaluation_ms),
    createdAt: row.created_at as string,
    syncStatus: 'SYNCED',
  };
}

export function mapReferral(row: Row): Referral {
  return {
    id: row.id as string,
    patientId: row.patient_id as string,
    visitId: row.visit_id as string,
    destination: row.destination as string,
    urgency: row.urgency as Urgency,
    reason: row.reason as string,
    status: row.status as ReferralStatus,
    followUpDate: (row.follow_up_date as string) ?? null,
    notes: (row.notes as string) ?? null,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    completedAt: (row.completed_at as string) ?? null,
    version: Number(row.version),
    syncStatus: 'SYNCED',
  };
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

/**
 * All six upserts below use INSERT ... ON CONFLICT DO UPDATE, which is valid in both
 * SQLite (3.24+) and PostgreSQL (9.5+), so the sync path needs no dialect branching.
 */

export async function upsertPatient(db: Db, p: Patient): Promise<void> {
  await db.run(
    'INSERT INTO patients (id, local_id, first_name, last_name, age, sex, village, phone,' +
      ' consent_status, created_by, created_at, updated_at, version)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT (id) DO UPDATE SET' +
      '  local_id = excluded.local_id, first_name = excluded.first_name,' +
      '  last_name = excluded.last_name, age = excluded.age, sex = excluded.sex,' +
      '  village = excluded.village, phone = excluded.phone,' +
      '  consent_status = excluded.consent_status, updated_at = excluded.updated_at,' +
      '  version = excluded.version',
    [
      p.id, p.localId, p.firstName, p.lastName, p.age, p.sex, p.village, p.phone,
      p.consentStatus, p.createdBy, p.createdAt, p.updatedAt, p.version,
    ],
  );
}

export async function upsertVisit(db: Db, v: Visit): Promise<void> {
  await db.run(
    'INSERT INTO visits (id, patient_id, chw_id, visit_date, village, notes, focus, created_at, updated_at, version)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT (id) DO UPDATE SET' +
      '  visit_date = excluded.visit_date, village = excluded.village, notes = excluded.notes,' +
      '  focus = excluded.focus, updated_at = excluded.updated_at, version = excluded.version',
    [v.id, v.patientId, v.chwId, v.visitDate, v.village, v.notes, v.focus ?? null, v.createdAt, v.updatedAt, v.version],
  );
}

export async function upsertVitals(db: Db, v: VitalSigns): Promise<void> {
  await db.run(
    'INSERT INTO vital_signs (id, visit_id, systolic_bp, diastolic_bp, temperature_c, weight_kg,' +
      ' pulse_bpm, oxygen_saturation, respiratory_rate, blood_glucose_mmol,' +
      ' muac_colour, malaria_rdt, oedema, pregnancy_weeks, recorded_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT (visit_id) DO UPDATE SET' +
      '  systolic_bp = excluded.systolic_bp, diastolic_bp = excluded.diastolic_bp,' +
      '  temperature_c = excluded.temperature_c, weight_kg = excluded.weight_kg,' +
      '  pulse_bpm = excluded.pulse_bpm, oxygen_saturation = excluded.oxygen_saturation,' +
      '  respiratory_rate = excluded.respiratory_rate,' +
      '  blood_glucose_mmol = excluded.blood_glucose_mmol, muac_colour = excluded.muac_colour,' +
      '  malaria_rdt = excluded.malaria_rdt, oedema = excluded.oedema,' +
      '  pregnancy_weeks = excluded.pregnancy_weeks, recorded_at = excluded.recorded_at',
    [
      v.id, v.visitId, v.systolicBp, v.diastolicBp, v.temperatureC, v.weightKg,
      v.pulseBpm, v.oxygenSaturation, v.respiratoryRate, v.bloodGlucoseMmol,
      v.muacColour ?? null, v.malariaRdt ?? null,
      v.oedema === null || v.oedema === undefined ? null : fromBool(v.oedema),
      v.pregnancyWeeks ?? null, v.recordedAt,
    ],
  );
}

export async function upsertSymptom(db: Db, s: Symptom): Promise<void> {
  await db.run(
    'INSERT INTO symptoms (id, visit_id, symptom_code, symptom_name, severity, duration_days)' +
      ' VALUES (?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT (visit_id, symptom_code) DO UPDATE SET' +
      '  severity = excluded.severity, duration_days = excluded.duration_days,' +
      '  symptom_name = excluded.symptom_name',
    [s.id, s.visitId, s.symptomCode, s.symptomName, s.severity, s.durationDays],
  );
}

export async function upsertTriage(db: Db, t: TriageResult): Promise<void> {
  await db.run(
    'INSERT INTO triage_results (id, visit_id, risk_level, triggered_rules, triggered_labels,' +
      ' recommendation, referral_required, ruleset_version, evaluation_ms, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT (visit_id) DO UPDATE SET' +
      '  risk_level = excluded.risk_level, triggered_rules = excluded.triggered_rules,' +
      '  triggered_labels = excluded.triggered_labels, recommendation = excluded.recommendation,' +
      '  referral_required = excluded.referral_required,' +
      '  ruleset_version = excluded.ruleset_version, evaluation_ms = excluded.evaluation_ms',
    [
      t.id, t.visitId, t.riskLevel, JSON.stringify(t.triggeredRules),
      JSON.stringify(t.triggeredLabels), t.recommendation, fromBool(t.referralRequired),
      t.rulesetVersion, t.evaluationMs, t.createdAt,
    ],
  );
}

export async function upsertReferral(db: Db, r: Referral): Promise<void> {
  await db.run(
    'INSERT INTO referrals (id, patient_id, visit_id, destination, urgency, reason, status,' +
      ' follow_up_date, notes, created_by, created_at, completed_at, version)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT (id) DO UPDATE SET' +
      '  destination = excluded.destination, urgency = excluded.urgency,' +
      '  reason = excluded.reason, status = excluded.status,' +
      '  follow_up_date = excluded.follow_up_date, notes = excluded.notes,' +
      '  completed_at = excluded.completed_at, version = excluded.version',
    [
      r.id, r.patientId, r.visitId, r.destination, r.urgency, r.reason, r.status,
      r.followUpDate, r.notes, r.createdBy, r.createdAt, r.completedAt, r.version,
    ],
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function findPatient(db: Db, id: string): Promise<Patient | null> {
  const row = await db.get('SELECT * FROM patients WHERE id = ?', [id]);
  return row ? mapPatient(row) : null;
}

export async function findVisit(db: Db, id: string): Promise<Visit | null> {
  const row = await db.get('SELECT * FROM visits WHERE id = ?', [id]);
  return row ? mapVisit(row) : null;
}

export async function findUserByUsername(db: Db, username: string): Promise<(User & { passwordHash: string }) | null> {
  const row = await db.get('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [username]);
  if (!row) return null;
  return { ...mapUser(row), passwordHash: row.password_hash as string };
}

export async function findUser(db: Db, id: string): Promise<User | null> {
  const row = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  return row ? mapUser(row) : null;
}

/** Loads the full clinical picture for one visit. */
export async function loadVisitBundle(db: Db, visitId: string) {
  const [vitalsRow, symptomRows, triageRow, referralRow] = await Promise.all([
    db.get('SELECT * FROM vital_signs WHERE visit_id = ?', [visitId]),
    db.all('SELECT * FROM symptoms WHERE visit_id = ? ORDER BY symptom_code', [visitId]),
    db.get('SELECT * FROM triage_results WHERE visit_id = ?', [visitId]),
    db.get('SELECT * FROM referrals WHERE visit_id = ? ORDER BY created_at DESC', [visitId]),
  ]);

  return {
    vitals: vitalsRow ? mapVitals(vitalsRow) : null,
    symptoms: symptomRows.map(mapSymptom),
    triage: triageRow ? mapTriage(triageRow) : null,
    referral: referralRow ? mapReferral(referralRow) : null,
  };
}
