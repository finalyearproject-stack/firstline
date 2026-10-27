/**
 * Audit logging (spec s17/s18: audit trail for sensitive operations).
 *
 * What is recorded: who, what action, which entity, when, from where.
 * What is NOT recorded: patient names, vitals, symptoms, diagnoses, or any other
 * clinical content. An audit log that contains the health data it is protecting is a
 * second copy of the sensitive record with weaker access controls around it.
 *
 * Metadata is restricted to non-identifying context — a village name, a count, a risk
 * level — and is passed through `scrubMetadata` before it is stored.
 */
import { uuid } from '@rhm/shared';
import type { Db } from '../db/index.ts';

export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILURE: 'LOGIN_FAILURE',
  LOGOUT: 'LOGOUT',
  PATIENT_CREATE: 'PATIENT_CREATE',
  PATIENT_UPDATE: 'PATIENT_UPDATE',
  PATIENT_VIEW: 'PATIENT_VIEW',
  PATIENT_LIST: 'PATIENT_LIST',
  VISIT_CREATE: 'VISIT_CREATE',
  TRIAGE_RECORD: 'TRIAGE_RECORD',
  REFERRAL_CREATE: 'REFERRAL_CREATE',
  REFERRAL_UPDATE: 'REFERRAL_UPDATE',
  SYNC_PUSH: 'SYNC_PUSH',
  USER_CREATE: 'USER_CREATE',
  USER_UPDATE: 'USER_UPDATE',
  RULESET_PUBLISH: 'RULESET_PUBLISH',
  AWARENESS_UPDATE: 'AWARENESS_UPDATE',
  AUDIT_VIEW: 'AUDIT_VIEW',
  PUBLIC_REPORT_CREATE: 'PUBLIC_REPORT_CREATE',
  PUBLIC_REPORT_REVIEW: 'PUBLIC_REPORT_REVIEW',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Keys that may never be written to the audit log, whatever a caller passes.
 * Enforced rather than documented, because the caller is the thing that forgets.
 */
const FORBIDDEN_METADATA_KEYS = new Set([
  'firstname', 'lastname', 'name', 'phone', 'dob', 'dateofbirth', 'address',
  'systolicbp', 'diastolicbp', 'temperature', 'temperaturec', 'weight', 'weightkg',
  'pulse', 'pulsebpm', 'oxygensaturation', 'bloodglucosemmol', 'symptoms',
  'notes', 'reason', 'recommendation', 'body', 'password', 'passwordhash', 'token',
]);

export function scrubMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue; // Only scalars; no nested payloads.
    clean[key] = value;
  }

  return Object.keys(clean).length > 0 ? clean : null;
}

export interface AuditInput {
  userId: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  const metadata = scrubMetadata(input.metadata);

  await db.run(
    'INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, timestamp, metadata, ip_address)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      uuid(),
      input.userId,
      input.action,
      input.entityType,
      input.entityId ?? null,
      new Date().toISOString(),
      metadata ? JSON.stringify(metadata) : null,
      input.ipAddress ?? null,
    ],
  );
}

/**
 * Audit writes must never break the clinical operation they are recording. If the
 * audit insert fails, the failure is logged to the server console and the request
 * proceeds — losing an audit line is bad, losing a patient record is worse.
 */
export async function recordAuditSafely(db: Db, input: AuditInput): Promise<void> {
  try {
    await recordAudit(db, input);
  } catch (error) {
    console.error('[audit] failed to record', input.action, error);
  }
}
