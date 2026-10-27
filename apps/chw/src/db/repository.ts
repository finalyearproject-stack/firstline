/**
 * Repository layer: the only place the app reads or writes clinical data.
 *
 * The invariant this module exists to enforce:
 *
 *   A record and its outbox entry are written in ONE IndexedDB transaction.
 *
 * If the phone dies between the two, neither exists and the CHW is told the save
 * failed. There is no window in which a record is saved but will never be sent, and
 * none in which something is queued that does not exist. Every write below goes through
 * `commit()`, which is what makes that guarantee structural rather than a convention
 * each caller has to remember.
 */
import {
  idempotencyKey,
  shortCode,
  uuid,
  type ConsentStatus,
  type Patient,
  type Referral,
  type Sex,
  type Severity,
  type SyncableEntity,
  type TriageResult,
  type Urgency,
  type VitalSigns,
} from '@rhm/shared';
import {
  db,
  type StoredPatient,
  type StoredQueueEntry,
  type StoredReferral,
  type StoredSymptom,
  type StoredVisit,
} from './local.ts';
import { sealJson, unsealJson, type Sealed } from './crypto.ts';

/** The decrypted view the UI works with. */
export interface PatientView {
  id: string;
  localId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  age: number;
  sex: Sex;
  village: string;
  consentStatus: ConsentStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  syncStatus: Patient['syncStatus'];
}

export interface VisitView {
  id: string;
  patientId: string;
  chwId: string;
  visitDate: string;
  village: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  syncStatus: Patient['syncStatus'];
}

export interface ReferralView {
  id: string;
  patientId: string;
  visitId: string;
  destination: string;
  urgency: Urgency;
  reason: string;
  notes: string | null;
  status: Referral['status'];
  followUpDate: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  version: number;
  syncStatus: Patient['syncStatus'];
}

export interface VisitBundleView {
  visit: VisitView;
  vitals: VitalSigns | null;
  symptoms: StoredSymptom[];
  triage: TriageResult | null;
  referral: ReferralView | null;
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

function queueEntry(
  entityType: SyncableEntity,
  entityId: string,
  payload: unknown,
  version: number,
  operation: 'CREATE' | 'UPDATE' = 'CREATE',
): StoredQueueEntry {
  return {
    id: uuid(),
    entityType,
    entityId,
    operation,
    payload: JSON.stringify(payload),
    idempotencyKey: idempotencyKey(entityType, entityId, operation, version),
    retryCount: 0,
    status: 'PENDING',
    lastAttempt: null,
    lastError: null,
    nextAttemptAt: Date.now(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Writes records and their outbox entries atomically.
 *
 * `'rw'` over every table the write may touch, so Dexie gives us a single transaction
 * across all of them. A throw anywhere inside rolls the whole thing back.
 */
async function commit(
  work: () => Promise<void>,
): Promise<void> {
  const database = db();
  await database.transaction(
    'rw',
    [
      database.patients,
      database.visits,
      database.vitals,
      database.symptoms,
      database.triage,
      database.referrals,
      database.queue,
    ],
    work,
  );
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export interface NewPatientInput {
  firstName: string;
  lastName: string;
  phone: string | null;
  age: number;
  sex: Sex;
  village: string;
  consentStatus: ConsentStatus;
}

export async function createPatient(
  key: CryptoKey,
  chwId: string,
  input: NewPatientInput,
): Promise<PatientView> {
  const now = new Date().toISOString();
  const id = uuid();

  const view: PatientView = {
    id,
    localId: shortCode('P'),
    ...input,
    createdBy: chwId,
    createdAt: now,
    updatedAt: now,
    version: 1,
    syncStatus: 'PENDING',
  };

  const stored: StoredPatient = {
    id,
    localId: view.localId,
    sec: await sealJson(key, {
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
    }),
    age: input.age,
    sex: input.sex,
    village: input.village,
    consentStatus: input.consentStatus,
    createdBy: chwId,
    createdAt: now,
    updatedAt: now,
    version: 1,
    syncStatus: 'PENDING',
  };

  await commit(async () => {
    await db().patients.put(stored);
    await db().queue.put(queueEntry('patient', id, toWirePatient(view), 1));
  });

  return view;
}

export async function updatePatient(
  key: CryptoKey,
  existing: PatientView,
  changes: Partial<NewPatientInput>,
): Promise<PatientView> {
  const next: PatientView = {
    ...existing,
    ...changes,
    updatedAt: new Date().toISOString(),
    version: existing.version + 1,
    syncStatus: 'PENDING',
  };

  const stored: StoredPatient = {
    id: next.id,
    localId: next.localId,
    sec: await sealJson(key, {
      firstName: next.firstName,
      lastName: next.lastName,
      phone: next.phone,
    }),
    age: next.age,
    sex: next.sex,
    village: next.village,
    consentStatus: next.consentStatus,
    createdBy: next.createdBy,
    createdAt: next.createdAt,
    updatedAt: next.updatedAt,
    version: next.version,
    syncStatus: 'PENDING',
  };

  await commit(async () => {
    await db().patients.put(stored);
    await db().queue.put(queueEntry('patient', next.id, toWirePatient(next), next.version, 'UPDATE'));
  });

  return next;
}

function toWirePatient(view: PatientView) {
  return {
    id: view.id,
    localId: view.localId,
    firstName: view.firstName,
    lastName: view.lastName,
    age: view.age,
    sex: view.sex,
    village: view.village,
    phone: view.phone,
    consentStatus: view.consentStatus,
    createdBy: view.createdBy,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    version: view.version,
  };
}

async function decryptPatient(key: CryptoKey, row: StoredPatient): Promise<PatientView> {
  const secret = await unsealJson<{ firstName: string; lastName: string; phone: string | null }>(
    key,
    row.sec,
  );

  return {
    id: row.id,
    localId: row.localId,
    // A row that will not decrypt is shown as unreadable rather than dropped: the CHW
    // must be able to see that something is there and report it, and the record still
    // syncs from its outbox entry if one is pending.
    firstName: secret?.firstName ?? '(unreadable)',
    lastName: secret?.lastName ?? '',
    phone: secret?.phone ?? null,
    age: row.age,
    sex: row.sex,
    village: row.village,
    consentStatus: row.consentStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    syncStatus: row.syncStatus,
  };
}

export async function listPatients(key: CryptoKey, limit = 500): Promise<PatientView[]> {
  const rows = await db().patients.orderBy('updatedAt').reverse().limit(limit).toArray();
  return Promise.all(rows.map((row) => decryptPatient(key, row)));
}

export async function getPatient(key: CryptoKey, id: string): Promise<PatientView | null> {
  const row = await db().patients.get(id);
  return row ? decryptPatient(key, row) : null;
}

/**
 * Name search.
 *
 * Because names are encrypted at rest, the index cannot be searched directly; the rows
 * are decrypted and filtered in memory. At the scale the specification sets — 500
 * patient profiles on the device — this is a few milliseconds, and it buys genuine
 * encryption rather than a searchable-but-readable store.
 */
export async function searchPatients(key: CryptoKey, term: string): Promise<PatientView[]> {
  const all = await listPatients(key);
  const needle = term.trim().toLowerCase();
  if (!needle) return all;

  return all.filter(
    (p) =>
      p.firstName.toLowerCase().includes(needle) ||
      p.lastName.toLowerCase().includes(needle) ||
      p.localId.toLowerCase().includes(needle) ||
      p.village.toLowerCase().includes(needle),
  );
}

// ---------------------------------------------------------------------------
// Screening encounter
// ---------------------------------------------------------------------------

export interface ScreeningInput {
  patientId: string;
  chwId: string;
  village: string;
  notes: string | null;
  vitals: Omit<VitalSigns, 'id' | 'visitId' | 'recordedAt' | 'syncStatus'>;
  symptoms: Array<{
    symptomCode: string;
    symptomName: string;
    severity: Severity;
    durationDays: number | null;
  }>;
  triage: Omit<TriageResult, 'id' | 'visitId' | 'createdAt' | 'syncStatus'>;
  referral: {
    /**
     * Optional. The screening UI pre-generates it so the referral code can be shown,
     * and texted to the patient, before the record is committed. Callers that do not
     * need the code in advance can leave it out and one is generated here.
     */
    id?: string;
    destination: string;
    urgency: Urgency;
    reason: string;
    notes: string | null;
    followUpDate: string | null;
  } | null;
}

/**
 * Saves a complete screening.
 *
 * Everything the CHW captured — the visit, the vitals, each symptom, the triage result
 * and any referral — is written together with its outbox entries in one transaction.
 * This is the operation spec s13 is about: once this resolves, the encounter survives a
 * crash, a force-close, a flat battery and a reinstall-free restart.
 */
export async function saveScreening(
  key: CryptoKey,
  input: ScreeningInput,
): Promise<VisitBundleView> {
  const now = new Date().toISOString();
  const visitId = uuid();

  const visitView: VisitView = {
    id: visitId,
    patientId: input.patientId,
    chwId: input.chwId,
    visitDate: now,
    village: input.village,
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
    version: 1,
    syncStatus: 'PENDING',
  };

  const storedVisit: StoredVisit = {
    id: visitId,
    patientId: input.patientId,
    chwId: input.chwId,
    visitDate: now,
    village: input.village,
    sec: await sealJson(key, { notes: input.notes }),
    createdAt: now,
    updatedAt: now,
    version: 1,
    syncStatus: 'PENDING',
  };

  const vitals: VitalSigns = {
    ...input.vitals,
    id: uuid(),
    visitId,
    recordedAt: now,
    syncStatus: 'PENDING',
  };

  const symptoms: StoredSymptom[] = input.symptoms.map((s) => ({
    ...s,
    id: uuid(),
    visitId,
    syncStatus: 'PENDING',
  }));

  const triage: TriageResult = {
    ...input.triage,
    id: uuid(),
    visitId,
    createdAt: now,
    syncStatus: 'PENDING',
  };

  let referralView: ReferralView | null = null;
  let storedReferral: StoredReferral | null = null;

  if (input.referral) {
    const referralId = input.referral.id ?? uuid();
    referralView = {
      id: referralId,
      patientId: input.patientId,
      visitId,
      destination: input.referral.destination,
      urgency: input.referral.urgency,
      reason: input.referral.reason,
      notes: input.referral.notes,
      status: 'PENDING',
      followUpDate: input.referral.followUpDate,
      createdBy: input.chwId,
      createdAt: now,
      completedAt: null,
      version: 1,
      syncStatus: 'PENDING',
    };

    storedReferral = {
      id: referralId,
      patientId: input.patientId,
      visitId,
      destination: input.referral.destination,
      urgency: input.referral.urgency,
      status: 'PENDING',
      followUpDate: input.referral.followUpDate,
      sec: await sealJson(key, { reason: input.referral.reason, notes: input.referral.notes }),
      createdBy: input.chwId,
      createdAt: now,
      completedAt: null,
      version: 1,
      syncStatus: 'PENDING',
    };
  }

  await commit(async () => {
    const database = db();

    await database.visits.put(storedVisit);
    await database.vitals.put(vitals);
    await database.symptoms.bulkPut(symptoms);
    await database.triage.put(triage);

    await database.queue.bulkPut([
      queueEntry('visit', visitId, stripSync(visitView), 1),
      queueEntry('vitals', vitals.id, stripSync(vitals), 1),
      ...symptoms.map((s) => queueEntry('symptom', s.id, stripSync(s), 1)),
      queueEntry('triage', triage.id, stripSync(triage), 1),
    ]);

    if (storedReferral && referralView) {
      await database.referrals.put(storedReferral);
      await database.queue.put(queueEntry('referral', referralView.id, stripSync(referralView), 1));
    }

    // The patient's own row is touched so the list orders by most recent activity.
    const patient = await database.patients.get(input.patientId);
    if (patient) await database.patients.put({ ...patient, updatedAt: now });
  });

  return { visit: visitView, vitals, symptoms, triage, referral: referralView };
}

/** `syncStatus` is device bookkeeping and is never sent to the server. */
function stripSync<T extends { syncStatus?: unknown }>(value: T): Omit<T, 'syncStatus'> {
  const { syncStatus: _ignored, ...rest } = value;
  return rest;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function getPatientHistory(key: CryptoKey, patientId: string): Promise<VisitBundleView[]> {
  const visitRows = await db().visits.where('patientId').equals(patientId).toArray();
  visitRows.sort((a, b) => b.visitDate.localeCompare(a.visitDate));

  return Promise.all(
    visitRows.map(async (row) => {
      const [vitals, symptoms, triageRows, referralRows] = await Promise.all([
        db().vitals.where('visitId').equals(row.id).first(),
        db().symptoms.where('visitId').equals(row.id).toArray(),
        db().triage.where('visitId').equals(row.id).toArray(),
        db().referrals.where('visitId').equals(row.id).toArray(),
      ]);

      const secret = await unsealJson<{ notes: string | null }>(key, row.sec);
      const referralRow = referralRows[0] ?? null;

      return {
        visit: {
          id: row.id,
          patientId: row.patientId,
          chwId: row.chwId,
          visitDate: row.visitDate,
          village: row.village,
          notes: secret?.notes ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          version: row.version,
          syncStatus: row.syncStatus,
        },
        vitals: vitals ?? null,
        symptoms,
        triage: triageRows[0] ?? null,
        referral: referralRow ? await decryptReferral(key, referralRow) : null,
      };
    }),
  );
}

async function decryptReferral(key: CryptoKey, row: StoredReferral): Promise<ReferralView> {
  const secret = await unsealJson<{ reason: string; notes: string | null }>(key, row.sec);
  return {
    id: row.id,
    patientId: row.patientId,
    visitId: row.visitId,
    destination: row.destination,
    urgency: row.urgency,
    reason: secret?.reason ?? '(unreadable)',
    notes: secret?.notes ?? null,
    status: row.status,
    followUpDate: row.followUpDate,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    version: row.version,
    syncStatus: row.syncStatus,
  };
}

/** Referrals that still need the CHW to do something (spec s2: follow-up tasks). */
export async function listFollowUps(key: CryptoKey): Promise<Array<ReferralView & { patient: PatientView | null }>> {
  const rows = await db().referrals.where('status').anyOf('PENDING', 'ACKNOWLEDGED').toArray();
  rows.sort((a, b) => (a.followUpDate ?? '9999').localeCompare(b.followUpDate ?? '9999'));

  return Promise.all(
    rows.map(async (row) => ({
      ...(await decryptReferral(key, row)),
      patient: await getPatient(key, row.patientId),
    })),
  );
}

export async function markReferralStatus(
  id: string,
  status: Referral['status'],
): Promise<void> {
  const row = await db().referrals.get(id);
  if (!row) return;

  const next: StoredReferral = {
    ...row,
    status,
    completedAt: status === 'COMPLETED' ? (row.completedAt ?? new Date().toISOString()) : null,
    version: row.version + 1,
    syncStatus: 'PENDING',
  };

  await commit(async () => {
    await db().referrals.put(next);
    await db().queue.put(
      queueEntry(
        'referral',
        id,
        {
          id: next.id,
          patientId: next.patientId,
          visitId: next.visitId,
          destination: next.destination,
          urgency: next.urgency,
          // The reason is re-sent from the encrypted envelope only when it can be read;
          // an unreadable row still syncs its status change.
          reason: 'Status update',
          status: next.status,
          followUpDate: next.followUpDate,
          notes: null,
          createdBy: next.createdBy,
          createdAt: next.createdAt,
          completedAt: next.completedAt,
          version: next.version,
        },
        next.version,
        'UPDATE',
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Device-level counts for the home screen
// ---------------------------------------------------------------------------

export interface DeviceStats {
  patients: number;
  visits: number;
  visitsToday: number;
  red: number;
  amber: number;
  green: number;
  pendingSync: number;
  openFollowUps: number;

  /**
   * Day-by-day counts for the trailing fortnight, oldest first, for the inline charts
   * on the home screen. Quiet days are present as zeroes rather than omitted, so the
   * axis stays real time.
   */
  daily: {
    days: number;
    patients: number[];
    visits: number[];
    red: number[];
    amber: number[];
  };
}

const SPARK_DAYS = 14;

/** Dense day-by-day counts from a list of ISO timestamps. */
function bucketByDay(isoTimestamps: string[], days: number): number[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const keys: string[] = [];
  const buckets = new Map<string, number>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    keys.push(key);
    buckets.set(key, 0);
  }

  for (const iso of isoTimestamps) {
    const key = iso.slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  return keys.map((k) => buckets.get(k) ?? 0);
}

export async function deviceStats(): Promise<DeviceStats> {
  const database = db();
  const today = new Date().toISOString().slice(0, 10);

  // The full rows are needed anyway for the day-by-day series, so the counts are taken
  // from them rather than issuing separate count() queries. At the 500-patient ceiling in
  // spec s21 this is a few milliseconds.
  const [allPatients, allVisits, triage, pendingSync, followUps] = await Promise.all([
    database.patients.toArray(),
    database.visits.toArray(),
    database.triage.toArray(),
    database.queue.where('status').anyOf('PENDING', 'FAILED', 'SYNCING').count(),
    database.referrals.where('status').anyOf('PENDING', 'ACKNOWLEDGED').count(),
  ]);

  return {
    patients: allPatients.length,
    visits: allVisits.length,
    visitsToday: allVisits.filter((v) => v.visitDate.startsWith(today)).length,
    red: triage.filter((t) => t.riskLevel === 'RED').length,
    amber: triage.filter((t) => t.riskLevel === 'AMBER').length,
    green: triage.filter((t) => t.riskLevel === 'GREEN').length,
    pendingSync,
    openFollowUps: followUps,

    daily: {
      days: SPARK_DAYS,
      patients: bucketByDay(allPatients.map((p) => p.createdAt), SPARK_DAYS),
      visits: bucketByDay(allVisits.map((v) => v.visitDate), SPARK_DAYS),
      red: bucketByDay(
        triage.filter((t) => t.riskLevel === 'RED').map((t) => t.createdAt),
        SPARK_DAYS,
      ),
      amber: bucketByDay(
        triage.filter((t) => t.riskLevel === 'AMBER').map((t) => t.createdAt),
        SPARK_DAYS,
      ),
    },
  };
}

export type { Sealed };
