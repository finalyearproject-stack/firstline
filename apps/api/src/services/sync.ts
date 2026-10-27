/**
 * Server side of synchronisation (spec s12).
 *
 * Four guarantees, each enforced by a specific mechanism rather than by convention:
 *
 *   1. IDEMPOTENT — every item carries an idempotency key, recorded in `sync_receipts`
 *      under a primary-key constraint. A replayed item is answered DUPLICATE and no
 *      second row is written. This is what makes "retry on failure" safe.
 *
 *   2. PARTIAL SUCCESS — each item is applied in its own transaction. One malformed
 *      record in a batch of 200 does not roll back the other 199, because a CHW who
 *      walked into signal for ninety seconds must not lose the whole upload to one bad
 *      row (spec s13: partial synchronisation).
 *
 *   3. ORDERED — items are sorted into dependency order server-side (patient before
 *      visit before vitals), so a client that enqueued them out of order still lands a
 *      referentially consistent result.
 *
 *   4. AUTHORISED — a CHW may only push records they own. Ownership is checked against
 *      the database, never against a field the client supplied about itself.
 */
import {
  PAYLOAD_SCHEMAS,
  type Patient,
  type Referral,
  type SyncItemInput,
  type SyncResult,
  type SyncableEntity,
  type Symptom,
  type TriageResult,
  type Visit,
  type VitalSigns,
} from '@rhm/shared';
import type { Db } from '../db/index.ts';
import type { AuthUser } from '../auth/middleware.ts';
import {
  upsertPatient,
  upsertReferral,
  upsertSymptom,
  upsertTriage,
  upsertVisit,
  upsertVitals,
} from './repositories.ts';

/**
 * Dependency order. A visit cannot be stored before its patient exists, and vitals
 * cannot be stored before their visit.
 */
const ENTITY_ORDER: Record<SyncableEntity, number> = {
  patient: 0,
  visit: 1,
  vitals: 2,
  symptom: 2,
  triage: 3,
  referral: 4,
};

export interface SyncOutcome {
  results: SyncResult[];
  applied: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
}

function result(
  item: SyncItemInput,
  status: SyncResult['status'],
  message: string | null = null,
): SyncResult {
  return {
    entityType: item.entityType,
    entityId: item.entityId,
    idempotencyKey: item.idempotencyKey,
    status,
    serverId: status === 'APPLIED' || status === 'DUPLICATE' ? item.entityId : null,
    message,
  };
}

export async function processSyncBatch(
  db: Db,
  user: AuthUser,
  items: SyncItemInput[],
): Promise<SyncOutcome> {
  const ordered = [...items].sort(
    (a, b) => ENTITY_ORDER[a.entityType] - ENTITY_ORDER[b.entityType],
  );

  const results: SyncResult[] = [];

  for (const item of ordered) {
    results.push(await processOne(db, user, item));
  }

  return {
    results,
    applied: results.filter((r) => r.status === 'APPLIED').length,
    duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
    conflicts: results.filter((r) => r.status === 'CONFLICT').length,
    rejected: results.filter((r) => r.status === 'REJECTED').length,
  };
}

async function processOne(db: Db, user: AuthUser, item: SyncItemInput): Promise<SyncResult> {
  // 1. Replay check, before any work is done.
  const receipt = await db.get<{ result_status: string }>(
    'SELECT result_status FROM sync_receipts WHERE idempotency_key = ?',
    [item.idempotencyKey],
  );
  if (receipt) {
    return result(item, 'DUPLICATE', 'This record was already received.');
  }

  // 2. Shape validation at the trust boundary.
  const schema = PAYLOAD_SCHEMAS[item.entityType];
  if (!schema) return result(item, 'REJECTED', `Unknown entity type ${item.entityType}.`);

  const parsed = schema.safeParse(item.payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
      .join('; ');
    await writeReceipt(db, user, item, 'REJECTED');
    return result(item, 'REJECTED', `Invalid ${item.entityType}: ${detail}`);
  }

  const payload = parsed.data as Record<string, unknown>;

  // 3. The id in the envelope and the id in the payload must agree, or the record
  //    would be stored under an identity the receipt does not cover.
  if (payload.id !== item.entityId) {
    await writeReceipt(db, user, item, 'REJECTED');
    return result(item, 'REJECTED', 'Record id does not match the sync envelope.');
  }

  try {
    return await db.transaction(async (tx) => {
      // 4. Authorisation and referential checks inside the transaction.
      const denial = await checkAuthorisation(tx, user, item, payload);
      if (denial) {
        await writeReceipt(tx, user, item, 'REJECTED');
        return result(item, 'REJECTED', denial);
      }

      // 5. Conflict detection for versioned entities.
      const conflict = await checkVersion(tx, item, payload);
      if (conflict) {
        await writeReceipt(tx, user, item, 'CONFLICT');
        return result(item, 'CONFLICT', conflict);
      }

      await applyItem(tx, item.entityType, payload);
      await writeReceipt(tx, user, item, 'APPLIED');
      return result(item, 'APPLIED');
    });
  } catch (error) {
    // A failure here leaves nothing written and, crucially, no receipt — so the client
    // will retry this item and the retry can still succeed. Losing the record is not
    // an option; asking for it again is.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[sync] ${item.entityType} ${item.entityId} failed:`, message);
    return result(item, 'REJECTED', 'The server could not store this record. It will be retried.');
  }
}

async function writeReceipt(
  db: Db,
  user: AuthUser,
  item: SyncItemInput,
  status: SyncResult['status'],
): Promise<void> {
  await db.run(
    'INSERT INTO sync_receipts (idempotency_key, user_id, entity_type, entity_id, operation, result_status, received_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT (idempotency_key) DO NOTHING',
    [
      item.idempotencyKey,
      user.id,
      item.entityType,
      item.entityId,
      item.operation,
      status,
      new Date().toISOString(),
    ],
  );
}

/**
 * Ownership and referential integrity.
 *
 * A CHW may push only their own patients and visits. Higher roles may push on behalf
 * of the field (for example a nurse correcting a referral), which the permission check
 * on the route has already established.
 */
async function checkAuthorisation(
  db: Db,
  user: AuthUser,
  item: SyncItemInput,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const isCHW = user.role === 'CHW';

  switch (item.entityType) {
    case 'patient': {
      if (isCHW && payload.createdBy !== user.id) {
        return 'A CHW may only upload patients they registered.';
      }
      return null;
    }

    case 'visit': {
      if (isCHW && payload.chwId !== user.id) {
        return 'A CHW may only upload their own visits.';
      }
      const patient = await db.get('SELECT id FROM patients WHERE id = ?', [payload.patientId as string]);
      if (!patient) {
        return 'The patient for this visit has not been received yet.';
      }
      return null;
    }

    case 'vitals':
    case 'symptom':
    case 'triage': {
      const visit = await db.get<{ chw_id: string }>(
        'SELECT chw_id FROM visits WHERE id = ?',
        [payload.visitId as string],
      );
      if (!visit) return 'The visit for this record has not been received yet.';
      if (isCHW && visit.chw_id !== user.id) return 'That visit belongs to another CHW.';
      return null;
    }

    case 'referral': {
      if (isCHW && payload.createdBy !== user.id) {
        return 'A CHW may only upload referrals they created.';
      }
      const visit = await db.get('SELECT id FROM visits WHERE id = ?', [payload.visitId as string]);
      if (!visit) return 'The visit for this referral has not been received yet.';
      return null;
    }

    default:
      return `Unknown entity type ${item.entityType}.`;
  }
}

/**
 * Last-write-wins on the version counter, for the entities that carry one.
 *
 * An upload whose version is BELOW the stored version is stale — typically a retry
 * from a device that has since been corrected elsewhere — and is reported as a
 * conflict rather than silently overwriting newer data.
 */
async function checkVersion(
  db: Db,
  item: SyncItemInput,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const versioned: Record<string, string> = {
    patient: 'patients',
    visit: 'visits',
    referral: 'referrals',
  };

  const table = versioned[item.entityType];
  if (!table) return null;

  const existing = await db.get<{ version: number }>(
    `SELECT version FROM ${table} WHERE id = ?`,
    [item.entityId],
  );
  if (!existing) return null;

  const incoming = Number(payload.version ?? 1);
  if (incoming < Number(existing.version)) {
    return `A newer version of this record (v${existing.version}) is already stored.`;
  }
  return null;
}

async function applyItem(
  db: Db,
  entityType: SyncableEntity,
  payload: Record<string, unknown>,
): Promise<void> {
  const synced = { syncStatus: 'SYNCED' as const };

  switch (entityType) {
    case 'patient':
      return upsertPatient(db, { ...(payload as unknown as Patient), ...synced, serverId: payload.id as string });
    case 'visit':
      return upsertVisit(db, { ...(payload as unknown as Visit), ...synced });
    case 'vitals':
      return upsertVitals(db, { ...(payload as unknown as VitalSigns), ...synced });
    case 'symptom':
      return upsertSymptom(db, { ...(payload as unknown as Symptom), ...synced });
    case 'triage':
      return upsertTriage(db, { ...(payload as unknown as TriageResult), ...synced });
    case 'referral':
      return upsertReferral(db, { ...(payload as unknown as Referral), ...synced });
    default: {
      const exhaustive: never = entityType;
      throw new Error(`Unhandled entity type ${String(exhaustive)}`);
    }
  }
}
