/**
 * Core domain types shared by the CHW client, the API and the dashboard.
 *
 * Every entity carries a client-generated UUID primary key. This is deliberate and is
 * the foundation of idempotent synchronisation (see `sync.ts`): a record has the same
 * identity the moment a CHW creates it offline as it does once the server has stored
 * it, so replaying an upload can never create a second copy.
 */

export const ROLES = ['CHW', 'NURSE', 'OFFICIAL', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const RISK_LEVELS = ['RED', 'AMBER', 'GREEN'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Per-record synchronisation state, surfaced verbatim to the CHW (spec s12/s20). */
export const SYNC_STATES = ['PENDING', 'SYNCING', 'SYNCED', 'FAILED'] as const;
export type SyncStatus = (typeof SYNC_STATES)[number];

export const CONSENT_STATES = ['GRANTED', 'DECLINED', 'WITHDRAWN'] as const;
export type ConsentStatus = (typeof CONSENT_STATES)[number];

export const URGENCIES = ['IMMEDIATE', 'WITHIN_24H', 'ROUTINE'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const REFERRAL_STATES = ['PENDING', 'ACKNOWLEDGED', 'COMPLETED', 'CANCELLED'] as const;
export type ReferralStatus = (typeof REFERRAL_STATES)[number];

export const SEXES = ['FEMALE', 'MALE', 'OTHER'] as const;
export type Sex = (typeof SEXES)[number];

export const SEVERITIES = ['MILD', 'MODERATE', 'SEVERE'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const USER_STATES = ['ACTIVE', 'SUSPENDED'] as const;
export type UserStatus = (typeof USER_STATES)[number];

/**
 * What a screening is for. The VHT picks one before starting; it decides which
 * questions are shown, never which rules run — every screening is still evaluated
 * against the whole rule set, so a danger sign outside the focus is not missed.
 */
export const SCREENING_FOCUSES = ['GENERAL', 'FEVER', 'COUGH', 'BLOOD_PRESSURE', 'PREGNANCY', 'CHILD'] as const;
export type ScreeningFocus = (typeof SCREENING_FOCUSES)[number];

/** Reading on the colour-coded MUAC tape in the VHT kit (MoH VHT guidelines 2010, s10). */
export const MUAC_COLOURS = ['RED', 'YELLOW', 'GREEN'] as const;
export type MuacColour = (typeof MUAC_COLOURS)[number];

/** Malaria rapid diagnostic test. A test that was not done is recorded as null. */
export const RDT_RESULTS = ['POSITIVE', 'NEGATIVE'] as const;
export type RdtResult = (typeof RDT_RESULTS)[number];

/** Entity kinds that may travel through the sync outbox. */
export const SYNCABLE_ENTITIES = [
  'patient',
  'visit',
  'vitals',
  'symptom',
  'triage',
  'referral',
] as const;
export type SyncableEntity = (typeof SYNCABLE_ENTITIES)[number];

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  name: string;
  phone: string | null;
  username: string;
  role: Role;
  /** Human-facing CHW badge number; null for non-field roles. */
  chwIdentifier: string | null;
  village: string | null;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Patient {
  /** Client-generated UUID. Stable across offline creation and server storage. */
  id: string;
  /** Mirror of `id` once the server has acknowledged the record; null while local-only. */
  serverId: string | null;
  /** Short human-readable code shown to the CHW, e.g. "P-4F2A". */
  localId: string;
  firstName: string;
  lastName: string;
  age: number;
  sex: Sex;
  village: string;
  phone: string | null;
  consentStatus: ConsentStatus;
  /** UUID of the CHW who registered the patient; used for ownership checks. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Monotonic counter used for last-write-wins conflict resolution. */
  version: number;
  syncStatus: SyncStatus;
}

export interface Visit {
  id: string;
  patientId: string;
  chwId: string;
  visitDate: string;
  village: string;
  notes: string | null;
  /** Absent on visits recorded before screening focus existed; read as GENERAL. */
  focus?: ScreeningFocus | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  syncStatus: SyncStatus;
}

export interface VitalSigns {
  id: string;
  visitId: string;
  systolicBp: number | null;
  diastolicBp: number | null;
  temperatureC: number | null;
  weightKg: number | null;
  pulseBpm: number | null;
  /** Only captured where the CHW has a pulse oximeter. */
  oxygenSaturation: number | null;
  respiratoryRate: number | null;
  /** Fasting/random blood glucose in mmol/L, where a glucometer is available. */
  bloodGlucoseMmol: number | null;
  /*
   * Kit measurements from the VHT guidelines. Optional so that records made by an
   * older app version, which never sent them, remain valid.
   */
  muacColour?: MuacColour | null;
  malariaRdt?: RdtResult | null;
  /** Swelling of both feet (bilateral pitting oedema), a sign of severe malnutrition. */
  oedema?: boolean | null;
  pregnancyWeeks?: number | null;
  recordedAt: string;
  syncStatus: SyncStatus;
}

export interface Symptom {
  id: string;
  visitId: string;
  symptomCode: string;
  symptomName: string;
  severity: Severity;
  /** Days the symptom has been present; drives duration-based rules. */
  durationDays: number | null;
  syncStatus: SyncStatus;
}

export interface TriageResult {
  id: string;
  visitId: string;
  riskLevel: RiskLevel;
  /** Rule IDs that fired, in descending severity order. */
  triggeredRules: string[];
  /** Plain-language indicator labels shown to the CHW. */
  triggeredLabels: string[];
  recommendation: string;
  referralRequired: boolean;
  /** Version of the rule set that produced this result, for auditability. */
  rulesetVersion: string;
  /** Milliseconds the engine took; asserted against the 1 s target in tests. */
  evaluationMs: number;
  createdAt: string;
  syncStatus: SyncStatus;
}

export interface Referral {
  id: string;
  patientId: string;
  visitId: string;
  /** Free-text or facility register name. */
  destination: string;
  urgency: Urgency;
  reason: string;
  status: ReferralStatus;
  /** ISO date the CHW should follow the patient up. */
  followUpDate: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  version: number;
  syncStatus: SyncStatus;
}

export interface AwarenessContent {
  id: string;
  title: string;
  /** BCP-47 tag, e.g. "en" or "lg" (Luganda). */
  language: string;
  category: string;
  summary: string;
  body: string;
  /** Path to a locally cached audio file, relative to the app origin. */
  audioPath: string | null;
  version: number;
  active: boolean;
  updatedAt: string;
}

export interface SyncQueueEntry {
  id: string;
  entityType: SyncableEntity;
  entityId: string;
  operation: 'CREATE' | 'UPDATE';
  /** Serialised entity payload captured at enqueue time. */
  payload: string;
  /** Stable key the server deduplicates on. */
  idempotencyKey: string;
  retryCount: number;
  status: SyncStatus;
  lastAttempt: string | null;
  lastError: string | null;
  /** Epoch ms before which the entry must not be retried (exponential backoff). */
  nextAttemptAt: number;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  timestamp: string;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
}

// ---------------------------------------------------------------------------
// Composite read models
// ---------------------------------------------------------------------------

/** Everything captured during one screening encounter. */
export interface VisitBundle {
  visit: Visit;
  vitals: VitalSigns | null;
  symptoms: Symptom[];
  triage: TriageResult | null;
  referral: Referral | null;
}

export interface PatientWithHistory {
  patient: Patient;
  visits: VisitBundle[];
}
