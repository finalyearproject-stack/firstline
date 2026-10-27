/**
 * Zod validation schemas.
 *
 * These are the single definition of what "valid" means. The CHW client validates with
 * them before writing to the local database, and the API validates with them again at
 * the trust boundary. Client-side validation is a usability feature; the server-side
 * pass is the security control, and it never assumes the client ran first.
 */
import { z } from 'zod';
import {
  CONSENT_STATES,
  REFERRAL_STATES,
  RISK_LEVELS,
  ROLES,
  SEVERITIES,
  SEXES,
  SYNCABLE_ENTITIES,
  SYNC_STATES,
  URGENCIES,
  USER_STATES,
} from './types.ts';

export const uuidSchema = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });

/**
 * Physiological bounds. These reject transcription errors (a systolic of 1650) without
 * rejecting genuine extremes that a CHW may legitimately record in the field.
 */
export const VITAL_BOUNDS = {
  systolicBp: { min: 50, max: 300, unit: 'mmHg' },
  diastolicBp: { min: 30, max: 200, unit: 'mmHg' },
  temperatureC: { min: 30, max: 45, unit: 'degC' },
  weightKg: { min: 1, max: 300, unit: 'kg' },
  pulseBpm: { min: 20, max: 250, unit: 'bpm' },
  oxygenSaturation: { min: 50, max: 100, unit: '%' },
  respiratoryRate: { min: 5, max: 90, unit: '/min' },
  bloodGlucoseMmol: { min: 1, max: 40, unit: 'mmol/L' },
} as const;

function bounded(key: keyof typeof VITAL_BOUNDS) {
  const { min, max } = VITAL_BOUNDS[key];
  return z.number().min(min).max(max).nullable();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(8).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  username: z.string().trim().min(3).max(64).regex(/^[a-z0-9._-]+$/i, 'letters, digits, . _ - only'),
  password: z.string().min(8).max(200),
  role: z.enum(ROLES),
  phone: z.string().trim().max(32).nullable().optional(),
  chwIdentifier: z.string().trim().max(32).nullable().optional(),
  village: z.string().trim().max(120).nullable().optional(),
  status: z.enum(USER_STATES).optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

// ---------------------------------------------------------------------------
// Clinical entities
// ---------------------------------------------------------------------------

export const patientSchema = z.object({
  id: uuidSchema,
  localId: z.string().trim().min(3).max(24),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  age: z.number().int().min(0).max(130),
  sex: z.enum(SEXES),
  village: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(32).nullable(),
  consentStatus: z.enum(CONSENT_STATES),
  createdBy: uuidSchema,
  createdAt: isoDate,
  updatedAt: isoDate,
  version: z.number().int().min(1),
});
export type PatientInput = z.infer<typeof patientSchema>;

export const visitSchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  chwId: uuidSchema,
  visitDate: isoDate,
  village: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(2000).nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  version: z.number().int().min(1),
});
export type VisitInput = z.infer<typeof visitSchema>;

export const vitalsSchema = z.object({
  id: uuidSchema,
  visitId: uuidSchema,
  systolicBp: bounded('systolicBp'),
  diastolicBp: bounded('diastolicBp'),
  temperatureC: bounded('temperatureC'),
  weightKg: bounded('weightKg'),
  pulseBpm: bounded('pulseBpm'),
  oxygenSaturation: bounded('oxygenSaturation'),
  respiratoryRate: bounded('respiratoryRate'),
  bloodGlucoseMmol: bounded('bloodGlucoseMmol'),
  recordedAt: isoDate,
}).refine(
  (v) => v.systolicBp === null || v.diastolicBp === null || v.systolicBp > v.diastolicBp,
  { message: 'Systolic must be higher than diastolic', path: ['systolicBp'] },
);
export type VitalsInput = z.infer<typeof vitalsSchema>;

export const symptomSchema = z.object({
  id: uuidSchema,
  visitId: uuidSchema,
  symptomCode: z.string().trim().min(1).max(64),
  symptomName: z.string().trim().min(1).max(120),
  severity: z.enum(SEVERITIES),
  durationDays: z.number().int().min(0).max(3650).nullable(),
});
export type SymptomInput = z.infer<typeof symptomSchema>;

export const triageSchema = z.object({
  id: uuidSchema,
  visitId: uuidSchema,
  riskLevel: z.enum(RISK_LEVELS),
  triggeredRules: z.array(z.string().max(64)).max(64),
  triggeredLabels: z.array(z.string().max(200)).max(64),
  recommendation: z.string().min(1).max(2000),
  referralRequired: z.boolean(),
  rulesetVersion: z.string().min(1).max(32),
  evaluationMs: z.number().min(0),
  createdAt: isoDate,
});
export type TriageInput = z.infer<typeof triageSchema>;

export const referralSchema = z.object({
  id: uuidSchema,
  patientId: uuidSchema,
  visitId: uuidSchema,
  destination: z.string().trim().min(1).max(200),
  urgency: z.enum(URGENCIES),
  reason: z.string().trim().min(1).max(1000),
  status: z.enum(REFERRAL_STATES),
  followUpDate: z.string().date().nullable(),
  notes: z.string().trim().max(2000).nullable(),
  createdBy: uuidSchema,
  createdAt: isoDate,
  completedAt: isoDate.nullable(),
  version: z.number().int().min(1),
});
export type ReferralInput = z.infer<typeof referralSchema>;

export const awarenessContentSchema = z.object({
  id: uuidSchema,
  title: z.string().trim().min(1).max(200),
  language: z.string().trim().min(2).max(12),
  category: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(20000),
  audioPath: z.string().trim().max(400).nullable(),
  version: z.number().int().min(1),
  active: z.boolean(),
});
export type AwarenessContentInput = z.infer<typeof awarenessContentSchema>;

// ---------------------------------------------------------------------------
// Synchronisation envelope
// ---------------------------------------------------------------------------

/** One record inside a sync batch. */
export const syncItemSchema = z.object({
  entityType: z.enum(SYNCABLE_ENTITIES),
  entityId: uuidSchema,
  operation: z.enum(['CREATE', 'UPDATE']),
  idempotencyKey: z.string().min(1).max(200),
  /** Validated against the per-entity schema once the type is known. */
  payload: z.unknown(),
});
export type SyncItemInput = z.infer<typeof syncItemSchema>;

export const syncRequestSchema = z.object({
  /** Client clock, recorded for drift diagnostics; never trusted for ordering. */
  clientTime: isoDate,
  items: z.array(syncItemSchema).min(1).max(200),
});
export type SyncRequestInput = z.infer<typeof syncRequestSchema>;

export const syncResultSchema = z.object({
  entityType: z.enum(SYNCABLE_ENTITIES),
  entityId: uuidSchema,
  idempotencyKey: z.string(),
  status: z.enum(['APPLIED', 'DUPLICATE', 'CONFLICT', 'REJECTED']),
  serverId: z.string().nullable(),
  message: z.string().nullable(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

/** Maps an entity kind to the schema its payload must satisfy. */
export const PAYLOAD_SCHEMAS = {
  patient: patientSchema,
  visit: visitSchema,
  vitals: vitalsSchema,
  symptom: symptomSchema,
  triage: triageSchema,
  referral: referralSchema,
} as const;

export const syncStatusSchema = z.enum(SYNC_STATES);
