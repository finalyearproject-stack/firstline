/**
 * Synchronisation tests (spec s12, s13, s24).
 *
 * These are the tests the offline-first claim rests on. The central assertion
 * throughout is the one the specification states outright: after a retry, after an
 * interruption, after a crash, "the server receives exactly one copy".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { idempotencyKey, uuid } from '@rhm/shared';
import {
  bearer,
  buildPatient,
  buildReferral,
  buildSymptom,
  buildTriage,
  buildVisit,
  buildVitals,
  createTestContext,
  createTestUser,
  login,
  syncItem,
  type TestContext,
  type TestUser,
} from './helpers/harness.ts';

let ctx: TestContext;
let chw: TestUser;
let otherChw: TestUser;
let token: string;

beforeEach(async () => {
  ctx = await createTestContext();
  chw = await createTestUser(ctx.db, { username: 'chw1', role: 'CHW', village: 'Kasangati' });
  otherChw = await createTestUser(ctx.db, { username: 'chw2', role: 'CHW', village: 'Nakifuma' });
  token = await login(ctx.app, 'chw1');
});

afterEach(async () => {
  await ctx.close();
});

function push(items: unknown[]) {
  return request(ctx.app)
    .post('/api/v1/sync')
    .set(bearer(token))
    .send({ clientTime: new Date().toISOString(), items });
}

async function countPatients(): Promise<number> {
  const row = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM patients');
  return Number(row?.n ?? 0);
}

describe('a complete offline encounter uploads in one batch', () => {
  it('stores patient, visit, vitals, symptoms, triage and referral together', async () => {
    const patient = buildPatient(chw.id);
    const visit = buildVisit(patient.id, chw.id);
    const vitals = buildVitals(visit.id);
    const symptom = buildSymptom(visit.id);
    const triage = buildTriage(visit.id);
    const referral = buildReferral(patient.id, visit.id, chw.id);

    const res = await push([
      syncItem('patient', patient),
      syncItem('visit', visit),
      syncItem('vitals', vitals),
      syncItem('symptom', symptom),
      syncItem('triage', triage),
      syncItem('referral', referral),
    ]).expect(200);

    expect(res.body.data.summary).toMatchObject({ received: 6, applied: 6, rejected: 0 });

    const stored = await ctx.db.get('SELECT * FROM patients WHERE id = ?', [patient.id]);
    expect(stored).toBeTruthy();

    const bundle = await ctx.db.get('SELECT * FROM triage_results WHERE visit_id = ?', [visit.id]);
    expect(bundle).toMatchObject({ risk_level: 'RED' });
  });

  it('accepts records sent in the wrong order by sorting them into dependency order', async () => {
    const patient = buildPatient(chw.id);
    const visit = buildVisit(patient.id, chw.id);
    const vitals = buildVitals(visit.id);

    // Deliberately reversed: vitals first, patient last.
    const res = await push([
      syncItem('vitals', vitals),
      syncItem('visit', visit),
      syncItem('patient', patient),
    ]).expect(200);

    expect(res.body.data.summary.applied).toBe(3);
    expect(res.body.data.summary.rejected).toBe(0);
  });
});

describe('idempotency (spec s12: the same record must not create duplicates)', () => {
  it('stores exactly one copy when the identical batch is sent twice', async () => {
    const patient = buildPatient(chw.id);
    const items = [syncItem('patient', patient)];

    const first = await push(items).expect(200);
    const second = await push(items).expect(200);

    expect(first.body.data.results[0].status).toBe('APPLIED');
    expect(second.body.data.results[0].status).toBe('DUPLICATE');
    expect(await countPatients()).toBe(1);
  });

  it('stores exactly one copy across ten retries of the same batch', async () => {
    const patient = buildPatient(chw.id);
    const visit = buildVisit(patient.id, chw.id);
    const items = [syncItem('patient', patient), syncItem('visit', visit)];

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await push(items).expect(200);
    }

    expect(await countPatients()).toBe(1);
    const visits = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM visits');
    expect(Number(visits?.n)).toBe(1);

    // One receipt per logical record, regardless of how many times it was offered.
    const receipts = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_receipts');
    expect(Number(receipts?.n)).toBe(2);
  });

  it('derives the same key for the same logical write, so a re-enqueued record is caught', () => {
    const id = uuid();
    expect(idempotencyKey('patient', id, 'CREATE', 1)).toBe(
      idempotencyKey('patient', id, 'CREATE', 1),
    );
    expect(idempotencyKey('patient', id, 'CREATE', 1)).not.toBe(
      idempotencyKey('patient', id, 'UPDATE', 2),
    );
  });

  it('does not double-record vitals when a visit is uploaded twice', async () => {
    const patient = buildPatient(chw.id);
    const visit = buildVisit(patient.id, chw.id);
    const vitals = buildVitals(visit.id, { systolicBp: 165 });

    const items = [syncItem('patient', patient), syncItem('visit', visit), syncItem('vitals', vitals)];
    await push(items).expect(200);
    await push(items).expect(200);

    const rows = await ctx.db.all('SELECT * FROM vital_signs WHERE visit_id = ?', [visit.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ systolic_bp: 165 });
  });
});

describe('partial success (spec s13: partial synchronisation)', () => {
  it('applies the good records in a batch that also contains a bad one', async () => {
    const patient = buildPatient(chw.id);
    const visit = buildVisit(patient.id, chw.id);
    const broken = buildVitals(visit.id, { systolicBp: 9999 }); // outside physiological bounds

    const res = await push([
      syncItem('patient', patient),
      syncItem('visit', visit),
      syncItem('vitals', broken),
    ]).expect(200);

    expect(res.body.data.summary.applied).toBe(2);
    expect(res.body.data.summary.rejected).toBe(1);

    // The patient and visit are safely stored; only the invalid record was refused.
    expect(await countPatients()).toBe(1);
    const vitals = await ctx.db.all('SELECT * FROM vital_signs');
    expect(vitals).toHaveLength(0);
  });

  it('reports a per-item verdict rather than failing the whole batch', async () => {
    const good = buildPatient(chw.id);
    const bad = buildPatient(chw.id, { age: 999 });

    const res = await push([syncItem('patient', good), syncItem('patient', bad)]).expect(200);

    const byId = Object.fromEntries(
      res.body.data.results.map((r: { entityId: string; status: string }) => [r.entityId, r.status]),
    );
    expect(byId[good.id]).toBe('APPLIED');
    expect(byId[bad.id]).toBe('REJECTED');
  });

  it('rejects an item whose payload id disagrees with the envelope', async () => {
    const patient = buildPatient(chw.id);
    const item = { ...syncItem('patient', patient), entityId: uuid() };

    const res = await push([item]).expect(200);
    expect(res.body.data.results[0].status).toBe('REJECTED');
    expect(await countPatients()).toBe(0);
  });
});

describe('authorisation during sync', () => {
  it('refuses a patient a CHW claims to have registered on another CHW’s behalf', async () => {
    const patient = buildPatient(otherChw.id);
    const res = await push([syncItem('patient', patient)]).expect(200);

    expect(res.body.data.results[0].status).toBe('REJECTED');
    expect(res.body.data.results[0].message).toMatch(/only upload patients they registered/i);
    expect(await countPatients()).toBe(0);
  });

  it('refuses vitals attached to another CHW’s visit', async () => {
    // chw2 legitimately owns this patient and visit.
    const patient = buildPatient(otherChw.id);
    const visit = buildVisit(patient.id, otherChw.id);
    const otherToken = await login(ctx.app, 'chw2');
    await request(ctx.app)
      .post('/api/v1/sync')
      .set(bearer(otherToken))
      .send({
        clientTime: new Date().toISOString(),
        items: [syncItem('patient', patient), syncItem('visit', visit)],
      })
      .expect(200);

    // chw1 now tries to attach vitals to it.
    const res = await push([syncItem('vitals', buildVitals(visit.id))]).expect(200);
    expect(res.body.data.results[0].status).toBe('REJECTED');
    expect(res.body.data.results[0].message).toMatch(/another CHW/i);
  });

  it('refuses a visit whose patient the server has never received', async () => {
    const visit = buildVisit(uuid(), chw.id);
    const res = await push([syncItem('visit', visit)]).expect(200);

    expect(res.body.data.results[0].status).toBe('REJECTED');
    expect(res.body.data.results[0].message).toMatch(/not been received yet/i);
  });

  it('refuses a sync push from a role without the permission', async () => {
    await createTestUser(ctx.db, { username: 'officer1', role: 'OFFICIAL' });
    const officer = await login(ctx.app, 'officer1');

    await request(ctx.app)
      .post('/api/v1/sync')
      .set(bearer(officer))
      .send({ clientTime: new Date().toISOString(), items: [syncItem('patient', buildPatient(chw.id))] })
      .expect(403);
  });
});

describe('conflict handling', () => {
  it('accepts a newer version and reports a stale one as a conflict', async () => {
    const patient = buildPatient(chw.id);
    await push([syncItem('patient', patient)]).expect(200);

    const v2 = { ...patient, version: 2, village: 'Nakifuma', updatedAt: new Date().toISOString() };
    const applied = await push([syncItem('patient', v2, 'UPDATE')]).expect(200);
    expect(applied.body.data.results[0].status).toBe('APPLIED');

    const stored = await ctx.db.get<{ village: string }>('SELECT village FROM patients WHERE id = ?', [
      patient.id,
    ]);
    expect(stored?.village).toBe('Nakifuma');

    // A stale device now offers version 1 again under a fresh key.
    const stale = {
      ...syncItem('patient', { ...patient, village: 'Kiwoko' }, 'UPDATE'),
      idempotencyKey: `patient:${patient.id}:UPDATE:stale`,
    };
    const conflict = await push([stale]).expect(200);

    expect(conflict.body.data.results[0].status).toBe('CONFLICT');
    const after = await ctx.db.get<{ village: string }>('SELECT village FROM patients WHERE id = ?', [
      patient.id,
    ]);
    expect(after?.village).toBe('Nakifuma'); // newer data was NOT overwritten
  });
});

describe('failure handling (spec s24: failure tests)', () => {
  it('refuses an oversized batch rather than partially accepting it', async () => {
    const items = Array.from({ length: 250 }, () => syncItem('patient', buildPatient(chw.id)));
    const res = await request(ctx.app)
      .post('/api/v1/sync')
      .set(bearer(token))
      .send({ clientTime: new Date().toISOString(), items });

    // Either the envelope schema caps it (400) or the route does (413); both are a
    // clean refusal that leaves the client queue intact.
    expect([400, 413]).toContain(res.status);
    expect(await countPatients()).toBe(0);
  });

  it('rejects an empty batch', async () => {
    await push([]).expect(400);
  });

  it('rejects a request with an expired token so the client can re-authenticate', async () => {
    const { issueToken } = await import('../apps/api/src/auth/jwt.ts');
    const { token: expired } = issueToken({ id: chw.id, username: chw.username, role: 'CHW' }, -5);

    const res = await request(ctx.app)
      .post('/api/v1/sync')
      .set(bearer(expired))
      .send({ clientTime: new Date().toISOString(), items: [syncItem('patient', buildPatient(chw.id))] })
      .expect(401);

    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    // Nothing was stored, so the client's queue still holds the record.
    expect(await countPatients()).toBe(0);
  });

  it('leaves no receipt when storage fails, so the record can still be retried', async () => {
    const patient = buildPatient(chw.id);
    const item = syncItem('patient', patient);

    // Simulate a transient storage failure on the first attempt.
    const originalRun = ctx.db.run.bind(ctx.db);
    let failed = false;
    ctx.db.run = async (sql: string, params?: (string | number | null)[]) => {
      if (!failed && sql.includes('INSERT INTO patients')) {
        failed = true;
        throw new Error('simulated disk failure');
      }
      return originalRun(sql, params);
    };

    const first = await push([item]).expect(200);
    expect(first.body.data.results[0].status).toBe('REJECTED');

    ctx.db.run = originalRun;

    // The retry must succeed: a failed attempt must not have poisoned the key.
    const second = await push([item]).expect(200);
    expect(second.body.data.results[0].status).toBe('APPLIED');
    expect(await countPatients()).toBe(1);
  });

  it('does not leak internal detail when something unexpected fails', async () => {
    const patient = buildPatient(chw.id);
    const originalRun = ctx.db.run.bind(ctx.db);
    ctx.db.run = async (sql: string, params?: (string | number | null)[]) => {
      if (sql.includes('INSERT INTO patients')) {
        throw new Error('SQLITE_CORRUPT: database disk image is malformed at /var/data/rhm.db');
      }
      return originalRun(sql, params);
    };

    const res = await push([syncItem('patient', patient)]).expect(200);
    ctx.db.run = originalRun;

    const message = res.body.data.results[0].message as string;
    expect(message).not.toMatch(/SQLITE_CORRUPT/);
    expect(message).not.toMatch(/var\/data/);
    expect(message).toMatch(/retried/i);
  });
});

describe('sync accounting', () => {
  it('reports what the server holds for this CHW', async () => {
    const patient = buildPatient(chw.id);
    await push([syncItem('patient', patient)]).expect(200);

    const res = await request(ctx.app)
      .get('/api/v1/sync/status')
      .set(bearer(token))
      .expect(200);

    expect(res.body.data.recordsReceived).toBe(1);
    expect(res.body.data.lastSyncAt).toBeTruthy();
  });

  it('writes one audit entry per batch, with counts but no clinical content', async () => {
    const patient = buildPatient(chw.id);
    await push([syncItem('patient', patient)]).expect(200);

    const row = await ctx.db.get<{ metadata: string }>(
      "SELECT metadata FROM audit_logs WHERE action = 'SYNC_PUSH'",
    );
    expect(row).toBeTruthy();

    const metadata = JSON.parse(row!.metadata);
    expect(metadata).toMatchObject({ items: 1, applied: 1 });
    expect(JSON.stringify(metadata)).not.toContain('Sarah');
  });
});

describe('throughput (spec s21: 100 records within ~60 seconds on a slow link)', () => {
  it('processes a 100-record batch well inside the server-side budget', async () => {
    const items: unknown[] = [];
    for (let i = 0; i < 20; i += 1) {
      const patient = buildPatient(chw.id);
      const visit = buildVisit(patient.id, chw.id);
      items.push(
        syncItem('patient', patient),
        syncItem('visit', visit),
        syncItem('vitals', buildVitals(visit.id)),
        syncItem('symptom', buildSymptom(visit.id)),
        syncItem('triage', buildTriage(visit.id)),
      );
    }
    expect(items).toHaveLength(100);

    const started = Date.now();
    const res = await push(items).expect(200);
    const elapsed = Date.now() - started;

    expect(res.body.data.summary.applied).toBe(100);
    // The 60 s target is end-to-end over a 2G link; the server's own share must be a
    // small fraction of it, leaving the rest of the budget for the network.
    expect(elapsed).toBeLessThan(10_000);
  });
});
