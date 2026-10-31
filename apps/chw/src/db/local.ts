/**
 * The local database — the source of truth for everything a CHW does (spec s4, s5).
 *
 * Nothing in the clinical workflow awaits the network. A screening is complete the
 * moment it is committed here; synchronisation is a separate, later, retryable concern
 * handled by the outbox in `sync/engine.ts`.
 *
 * Record shape: identifying fields live inside a `sec` envelope that is encrypted
 * before it is written (see `crypto.ts`). Everything else stays in the clear so the
 * app can index, filter and count without holding the key.
 */
import Dexie, { type Table } from 'dexie';
import type {
  ConsentStatus,
  Referral,
  RiskLevel,
  Severity,
  ScreeningFocus,
  Sex,
  SyncStatus,
  SyncableEntity,
  TriageResult,
  Urgency,
  VitalSigns,
} from '@rhm/shared';
import type { Sealed } from './crypto.ts';

// ---------------------------------------------------------------------------
// Stored row shapes
// ---------------------------------------------------------------------------

/** Encrypted at rest: first name, last name, phone. */
export interface PatientSecret {
  firstName: string;
  lastName: string;
  phone: string | null;
}

export interface StoredPatient {
  id: string;
  localId: string;
  /** Encrypted identifying fields. */
  sec: Sealed;
  age: number;
  sex: Sex;
  village: string;
  consentStatus: ConsentStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  syncStatus: SyncStatus;
}

export interface VisitSecret {
  notes: string | null;
}

export interface StoredVisit {
  id: string;
  patientId: string;
  chwId: string;
  visitDate: string;
  village: string;
  /** Not secret: what the screening was for. Absent on visits saved by older versions. */
  focus?: ScreeningFocus | null;
  sec: Sealed;
  createdAt: string;
  updatedAt: string;
  version: number;
  syncStatus: SyncStatus;
}

/**
 * Vital signs are stored in the clear.
 *
 * A blood pressure reading is not identifying on its own: without the patient row it
 * decrypts to nothing but a number attached to a random UUID. Keeping it indexable is
 * what lets the app compute a patient's trend and the device's counts instantly.
 */
export type StoredVitals = VitalSigns;

export interface StoredSymptom {
  id: string;
  visitId: string;
  symptomCode: string;
  symptomName: string;
  severity: Severity;
  durationDays: number | null;
  syncStatus: SyncStatus;
}

export type StoredTriage = TriageResult;

export interface ReferralSecret {
  reason: string;
  notes: string | null;
}

export interface StoredReferral {
  id: string;
  patientId: string;
  visitId: string;
  destination: string;
  urgency: Urgency;
  status: Referral['status'];
  followUpDate: string | null;
  sec: Sealed;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  version: number;
  syncStatus: SyncStatus;
}

export interface StoredQueueEntry {
  id: string;
  entityType: SyncableEntity;
  entityId: string;
  operation: 'CREATE' | 'UPDATE';
  /** The serialised, DECRYPTED payload destined for the server over TLS. */
  payload: string;
  idempotencyKey: string;
  retryCount: number;
  status: SyncStatus;
  lastAttempt: string | null;
  lastError: string | null;
  nextAttemptAt: number;
  createdAt: string;
}

export interface StoredAwareness {
  id: string;
  title: string;
  language: string;
  category: string;
  summary: string;
  body: string;
  audioPath: string | null;
  version: number;
  active: number;
  updatedAt: string;
}

/** Small key/value store for device state: salt, verifier, session, cached rule set. */
export interface MetaRow {
  key: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export class LocalDatabase extends Dexie {
  patients!: Table<StoredPatient, string>;
  visits!: Table<StoredVisit, string>;
  vitals!: Table<StoredVitals, string>;
  symptoms!: Table<StoredSymptom, string>;
  triage!: Table<StoredTriage, string>;
  referrals!: Table<StoredReferral, string>;
  queue!: Table<StoredQueueEntry, string>;
  awareness!: Table<StoredAwareness, string>;
  meta!: Table<MetaRow, string>;

  constructor(name = 'rhm-chw') {
    super(name);

    // Indexes are chosen for the three questions the app asks constantly: "which of my
    // patients is this", "what happened at this visit", and "what still needs sending".
    this.version(1).stores({
      patients: 'id, village, updatedAt, syncStatus, localId',
      visits: 'id, patientId, visitDate, syncStatus',
      vitals: 'id, visitId',
      symptoms: 'id, visitId, symptomCode',
      triage: 'id, visitId, riskLevel, createdAt',
      referrals: 'id, patientId, visitId, status, followUpDate, syncStatus',
      queue: 'id, status, nextAttemptAt, entityType, entityId',
      awareness: 'id, language, category, active',
      meta: 'key',
    });
  }
}

let instance: LocalDatabase | null = null;

export function db(): LocalDatabase {
  instance ??= new LocalDatabase();
  return instance;
}

/** Test seam: lets the offline tests open an isolated database per case. */
export function setDatabase(next: LocalDatabase | null): void {
  instance = next;
}

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

export const META_KEYS = {
  pinSalt: 'pin.salt',
  pinVerifier: 'pin.verifier',
  pinAttempts: 'pin.attempts',
  session: 'session', // encrypted: { token, expiresAt, user }
  ruleset: 'triage.ruleset',
  lastSyncAt: 'sync.lastAt',
  deviceId: 'device.id',
  awarenessSeeded: 'awareness.seeded',
  recentFacilities: 'referral.recentFacilities',
} as const;

export async function getMeta<T>(key: string): Promise<T | null> {
  const row = await db().meta.get(key);
  return row ? (row.value as T) : null;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db().meta.put({ key, value });
}

export async function deleteMeta(key: string): Promise<void> {
  await db().meta.delete(key);
}

/**
 * Counts every record still waiting to reach the server. Drives the sync indicator
 * that the specification requires to be visible at all times (spec s20).
 */
export async function pendingCount(): Promise<number> {
  return db().queue.where('status').anyOf('PENDING', 'FAILED', 'SYNCING').count();
}

export async function storageEstimate(): Promise<{ usedMb: number; quotaMb: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return {
    usedMb: Math.round((usage / 1024 / 1024) * 10) / 10,
    quotaMb: Math.round((quota / 1024 / 1024) * 10) / 10,
  };
}

/**
 * Asks the browser to make storage persistent.
 *
 * Without this, a browser under storage pressure may evict IndexedDB — which for this
 * application would mean losing patient records that have not synchronised yet. This is
 * requested once, immediately after the CHW signs in.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export type { RiskLevel };
