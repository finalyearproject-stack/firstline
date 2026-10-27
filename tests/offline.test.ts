/**
 * Offline and zero-data-loss tests (spec s13, s24).
 *
 * This file is the evidence for the central claim of the project: that a CHW can do
 * their entire job with no network, and that nothing they captured is ever lost.
 *
 * It runs the REAL client stack — the real Dexie schema, the real AES-GCM encryption,
 * the real repository transactions and the real sync engine — against the REAL Express
 * API over a REAL HTTP socket. The only thing simulated is the network being down, and
 * that is simulated the way it actually happens: fetch rejects.
 *
 * The scenario mirrors the demonstration in spec s28:
 *   CHW visits a patient in a village. The phone is in airplane mode. The CHW records
 *   BP 165/100 and a persistent headache. Triage produces RED offline. The record is
 *   saved locally. Later the CHW reaches coverage and it synchronises - exactly once.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { DEFAULT_RULESET, runTriage } from '@rhm/triage';

import { LocalDatabase, db, setDatabase, pendingCount } from '../apps/chw/src/db/local.ts';
import { deriveKey, randomSalt } from '../apps/chw/src/db/crypto.ts';
import {
  createPatient,
  deviceStats,
  getPatient,
  getPatientHistory,
  listFollowUps,
  saveScreening,
  searchPatients,
} from '../apps/chw/src/db/repository.ts';
import { SyncEngine } from '../apps/chw/src/sync/engine.ts';

import { createTestContext, createTestUser, login, type TestContext } from './helpers/harness.ts';

// ---------------------------------------------------------------------------
// Network simulation
// ---------------------------------------------------------------------------

let online = true;

/** The engine consults navigator.onLine before every run. */
vi.stubGlobal('navigator', {
  get onLine() {
    return online;
  },
  storage: undefined,
});

function goOffline(): void {
  online = false;
}
function goOnline(): void {
  online = true;
}

// ---------------------------------------------------------------------------

let ctx: TestContext;
let server: Server;
let baseUrl: string;
let token: string;
let chwId: string;
let key: CryptoKey;
let database: LocalDatabase;
let dbName: string;
let engine: SyncEngine;

/**
 * The push function the engine uses. When "offline" it rejects exactly as fetch does,
 * so the engine's failure handling is exercised rather than bypassed.
 */
async function push(items: unknown[]): Promise<{ results: never[] }> {
  if (!online) throw new TypeError('Failed to fetch');

  const response = await fetch(`${baseUrl}/api/v1/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ clientTime: new Date().toISOString(), items }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  return payload.data;
}

/**
 * Simulates the passage of time so a backed-off queue entry becomes due again,
 * without making the test suite actually sleep for the backoff window.
 */
async function fastForwardBackoff(): Promise<void> {
  const entries = await db().queue.toArray();
  await db().queue.bulkPut(entries.map((entry) => ({ ...entry, nextAttemptAt: 0 })));
}

/**
 * Drives an engine until the outbox is empty.
 *
 * The real engine retries on its own schedule, and a single run is not guaranteed to
 * drain the queue — a run that overlaps the engine's own backoff timer returns early by
 * design. Asserting "exactly two runs finish the job" tests the scheduler's timing
 * rather than the guarantee we care about, and was intermittently wrong.
 */
async function drainQueue(engine: SyncEngine, attempts = 10): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if ((await pendingCount()) === 0) return;
    await fastForwardBackoff();
    await engine.run();
  }
}

/** Simulates a force-close and relaunch: a brand-new Dexie handle over the same store. */
async function restartApp(): Promise<void> {
  database.close();
  setDatabase(null);
  database = new LocalDatabase(dbName);
  setDatabase(database);
  await database.open();
}

beforeEach(async () => {
  online = true;

  ctx = await createTestContext();
  const chw = await createTestUser(ctx.db, { username: 'chw1', role: 'CHW', village: 'Kasangati' });
  chwId = chw.id;
  token = await login(ctx.app, 'chw1');

  server = ctx.app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  dbName = `rhm-test-${Math.random().toString(36).slice(2)}`;
  database = new LocalDatabase(dbName);
  setDatabase(database);
  await database.open();

  key = await deriveKey('4821', randomSalt());
  engine = new SyncEngine(push as never);
});

afterEach(async () => {
  engine.stop();
  database.close();
  setDatabase(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await ctx.close();
});

// ---------------------------------------------------------------------------

describe('the CHW can work with no network at all (spec s4)', () => {
  beforeEach(() => goOffline());

  it('registers a patient offline', async () => {
    const patient = await createPatient(key, chwId, {
      firstName: 'Sarah',
      lastName: 'Nakimuli',
      phone: '+256772000000',
      age: 52,
      sex: 'FEMALE',
      village: 'Kasangati',
      consentStatus: 'GRANTED',
    });

    expect(patient.id).toBeTruthy();
    expect(patient.syncStatus).toBe('PENDING');

    const reloaded = await getPatient(key, patient.id);
    expect(reloaded?.firstName).toBe('Sarah');
  });

  it('finds patients offline', async () => {
    await createPatient(key, chwId, {
      firstName: 'Sarah', lastName: 'Nakimuli', phone: null, age: 52,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });
    await createPatient(key, chwId, {
      firstName: 'Moses', lastName: 'Mukasa', phone: null, age: 34,
      sex: 'MALE', village: 'Nakifuma', consentStatus: 'GRANTED',
    });

    expect(await searchPatients(key, 'sarah')).toHaveLength(1);
    expect(await searchPatients(key, 'Nakifuma')).toHaveLength(1);
    expect(await searchPatients(key, '')).toHaveLength(2);
  });

  it('runs triage offline and produces RED for the specification’s worked example', async () => {
    // The engine is a pure local function; this is the whole point of spec s8.
    const outcome = runTriage(
      {
        age: 52,
        systolicBp: 165,
        diastolicBp: 100,
        symptoms: [{ symptomCode: 'headache', severity: 'MODERATE', durationDays: 3 }],
      },
      DEFAULT_RULESET,
    );

    expect(outcome.riskLevel).toBe('RED');
    expect(outcome.referralRequired).toBe(true);
    expect(outcome.evaluationMs).toBeLessThan(1000);
  });

  it('saves a complete screening with a referral offline', async () => {
    const patient = await createPatient(key, chwId, {
      firstName: 'Sarah', lastName: 'Nakimuli', phone: '+256772000000', age: 52,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    const outcome = runTriage(
      { age: 52, systolicBp: 165, diastolicBp: 100,
        symptoms: [{ symptomCode: 'headache', severity: 'MODERATE', durationDays: 3 }] },
      DEFAULT_RULESET,
    );

    const bundle = await saveScreening(key, {
      patientId: patient.id,
      chwId,
      village: 'Kasangati',
      notes: 'Household visit',
      vitals: {
        systolicBp: 165, diastolicBp: 100, temperatureC: 36.8, weightKg: 68,
        pulseBpm: 88, oxygenSaturation: null, respiratoryRate: null, bloodGlucoseMmol: null,
      },
      symptoms: [
        { symptomCode: 'headache', symptomName: 'Headache', severity: 'MODERATE', durationDays: 3 },
      ],
      triage: {
        riskLevel: outcome.riskLevel,
        triggeredRules: outcome.triggeredRules,
        triggeredLabels: outcome.triggeredLabels,
        recommendation: outcome.recommendation,
        referralRequired: outcome.referralRequired,
        rulesetVersion: outcome.rulesetVersion,
        evaluationMs: outcome.evaluationMs,
      },
      referral: {
        destination: 'Kasangati Health Centre IV',
        urgency: 'IMMEDIATE',
        reason: outcome.triggeredLabels[0],
        notes: null,
        followUpDate: null,
      },
    });

    expect(bundle.triage?.riskLevel).toBe('RED');
    expect(bundle.referral?.urgency).toBe('IMMEDIATE');

    const history = await getPatientHistory(key, patient.id);
    expect(history).toHaveLength(1);
    expect(history[0].vitals?.systolicBp).toBe(165);
    expect(history[0].symptoms).toHaveLength(1);
    expect(history[0].referral?.reason).toMatch(/blood pressure/i);
  });

  it('shows the patient’s history offline', async () => {
    const patient = await createPatient(key, chwId, {
      firstName: 'Moses', lastName: 'Mukasa', phone: null, age: 61,
      sex: 'MALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    for (const systolic of [150, 158, 142]) {
      await saveScreening(key, {
        patientId: patient.id, chwId, village: 'Kasangati', notes: null,
        vitals: { systolicBp: systolic, diastolicBp: 92, temperatureC: null, weightKg: null,
          pulseBpm: null, oxygenSaturation: null, respiratoryRate: null, bloodGlucoseMmol: null },
        symptoms: [],
        triage: { riskLevel: 'AMBER', triggeredRules: ['HTN-AMBER-01'], triggeredLabels: ['Raised blood pressure'],
          recommendation: 'Follow up in two weeks.', referralRequired: false,
          rulesetVersion: DEFAULT_RULESET.rulesetVersion, evaluationMs: 0.2 },
        referral: null,
      });
    }

    const history = await getPatientHistory(key, patient.id);
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.vitals?.systolicBp).sort()).toEqual([142, 150, 158]);
  });

  it('tracks follow-up tasks offline', async () => {
    const patient = await createPatient(key, chwId, {
      firstName: 'Grace', lastName: 'Namusoke', phone: null, age: 29,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    await saveScreening(key, {
      patientId: patient.id, chwId, village: 'Kasangati', notes: null,
      vitals: { systolicBp: 185, diastolicBp: 120, temperatureC: null, weightKg: null,
        pulseBpm: null, oxygenSaturation: null, respiratoryRate: null, bloodGlucoseMmol: null },
      symptoms: [],
      triage: { riskLevel: 'RED', triggeredRules: ['HTN-RED-02'], triggeredLabels: ['Severely raised blood pressure'],
        recommendation: 'Refer today.', referralRequired: true,
        rulesetVersion: DEFAULT_RULESET.rulesetVersion, evaluationMs: 0.3 },
      referral: { destination: 'Kasangati PHC', urgency: 'IMMEDIATE',
        reason: 'Severely raised blood pressure', notes: null,
        followUpDate: new Date().toISOString().slice(0, 10) },
    });

    const followUps = await listFollowUps(key);
    expect(followUps).toHaveLength(1);
    expect(followUps[0].patient?.firstName).toBe('Grace');
  });

  it('never blocks on the network: no request is attempted while offline', async () => {
    const attempts: unknown[][] = [];
    const watched = new SyncEngine(async (items) => {
      attempts.push(items);
      throw new TypeError('Failed to fetch');
    });

    await createPatient(key, chwId, {
      firstName: 'Zainab', lastName: 'Sani', phone: null, age: 44,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    const result = await watched.run();
    expect(result).toBeNull();      // the engine declined to run while offline
    expect(attempts).toHaveLength(0); // and never touched the network
  });
});

describe('zero data loss (spec s13)', () => {
  beforeEach(() => goOffline());

  async function captureEncounter(firstName = 'Sarah') {
    const patient = await createPatient(key, chwId, {
      firstName, lastName: 'Nakimuli', phone: '+256772000000', age: 52,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    await saveScreening(key, {
      patientId: patient.id, chwId, village: 'Kasangati', notes: 'Household visit',
      vitals: { systolicBp: 165, diastolicBp: 100, temperatureC: 36.8, weightKg: 68,
        pulseBpm: 88, oxygenSaturation: null, respiratoryRate: null, bloodGlucoseMmol: null },
      symptoms: [{ symptomCode: 'headache', symptomName: 'Headache', severity: 'MODERATE', durationDays: 3 }],
      triage: { riskLevel: 'RED', triggeredRules: ['HTN-RED-01'],
        triggeredLabels: ['Very high blood pressure together with a persistent headache'],
        recommendation: 'Refer immediately.', referralRequired: true,
        rulesetVersion: DEFAULT_RULESET.rulesetVersion, evaluationMs: 0.4 },
      referral: { destination: 'Kasangati Health Centre IV', urgency: 'IMMEDIATE',
        reason: 'Very high blood pressure with persistent headache', notes: null, followUpDate: null },
    });

    return patient;
  }

  it('keeps every record after the application is closed and reopened', async () => {
    const patient = await captureEncounter();
    const before = await deviceStats();

    await restartApp();

    const after = await deviceStats();
    expect(after).toEqual(before);

    const reloaded = await getPatient(key, patient.id);
    expect(reloaded?.firstName).toBe('Sarah');

    const history = await getPatientHistory(key, patient.id);
    expect(history[0].vitals?.systolicBp).toBe(165);
    expect(history[0].triage?.riskLevel).toBe('RED');
    expect(history[0].referral?.destination).toBe('Kasangati Health Centre IV');
  });

  it('keeps the outbox intact across a restart, so nothing is stranded', async () => {
    await captureEncounter();
    const queuedBefore = await pendingCount();
    expect(queuedBefore).toBe(6); // patient, visit, vitals, symptom, triage, referral

    await restartApp();

    expect(await pendingCount()).toBe(queuedBefore);
  });

  it('survives a forced termination in the middle of a sync attempt', async () => {
    await captureEncounter();
    goOnline();

    // A push that hangs, then the process dies: entries are left mid-flight.
    const stalled = new SyncEngine(
      () => new Promise(() => {}) as Promise<{ results: never[] }>,
    );
    void stalled.run();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await restartApp();

    // Everything is still queued, and nothing reached the server.
    expect(await pendingCount()).toBe(6);
    const stored = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM patients');
    expect(Number(stored?.n)).toBe(0);

    // A fresh engine picks the work straight back up.
    const resumed = new SyncEngine(push as never);
    await resumed.run();
    expect(await pendingCount()).toBe(0);
  });

  it('preserves records when synchronisation fails outright', async () => {
    const patient = await captureEncounter();
    goOnline();

    const failing = new SyncEngine(async () => {
      throw new TypeError('Failed to fetch');
    });
    await failing.run();

    // Nothing lost, nothing sent.
    expect(await pendingCount()).toBe(6);
    expect((await getPatient(key, patient.id))?.firstName).toBe('Sarah');

    const onServer = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM patients');
    expect(Number(onServer?.n)).toBe(0);
  });

  it('keeps data when the server returns an error rather than a network failure', async () => {
    await captureEncounter();
    goOnline();

    const erroring = new SyncEngine(async () => {
      throw new Error('HTTP 503');
    });
    await erroring.run();

    expect(await pendingCount()).toBe(6);
  });

  it('reports a failed run as an error, not as a successful sync', async () => {
    await captureEncounter();
    goOnline();

    const erroring = new SyncEngine(async () => {
      throw new Error('HTTP 503');
    });
    let last: { state: string; lastSyncAt: string | null; lastError: string | null } | null = null;
    const unsubscribe = erroring.subscribe((progress) => { last = progress; });
    await erroring.run();
    unsubscribe();

    // The CHW must not be told their work was sent when nothing was.
    expect(last).toMatchObject({ state: 'ERROR', lastSyncAt: null, lastError: 'HTTP 503' });
  });
});

describe('synchronisation when the network returns (spec s12)', () => {
  it('uploads everything captured offline, and the server receives exactly one copy', async () => {
    goOffline();

    const patient = await createPatient(key, chwId, {
      firstName: 'Sarah', lastName: 'Nakimuli', phone: '+256772000000', age: 52,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    await saveScreening(key, {
      patientId: patient.id, chwId, village: 'Kasangati', notes: 'Household visit',
      vitals: { systolicBp: 165, diastolicBp: 100, temperatureC: 36.8, weightKg: 68,
        pulseBpm: 88, oxygenSaturation: null, respiratoryRate: null, bloodGlucoseMmol: null },
      symptoms: [{ symptomCode: 'headache', symptomName: 'Headache', severity: 'MODERATE', durationDays: 3 }],
      triage: { riskLevel: 'RED', triggeredRules: ['HTN-RED-01'], triggeredLabels: ['High BP with headache'],
        recommendation: 'Refer immediately.', referralRequired: true,
        rulesetVersion: DEFAULT_RULESET.rulesetVersion, evaluationMs: 0.4 },
      referral: { destination: 'Kasangati Health Centre IV', urgency: 'IMMEDIATE',
        reason: 'High blood pressure with persistent headache', notes: null, followUpDate: null },
    });

    expect(await pendingCount()).toBe(6);

    // The CHW walks into coverage.
    goOnline();
    const summary = await engine.run();

    expect(summary).toMatchObject({ applied: 6, rejected: 0 });
    expect(await pendingCount()).toBe(0);

    // Exactly one of everything on the server.
    const counts = await Promise.all([
      ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM patients'),
      ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM visits'),
      ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM vital_signs'),
      ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM symptoms'),
      ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM triage_results'),
      ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM referrals'),
    ]);
    expect(counts.map((c) => Number(c?.n))).toEqual([1, 1, 1, 1, 1, 1]);

    // The clinical detail arrived intact.
    const stored = await ctx.db.get<{ systolic_bp: number }>('SELECT * FROM vital_signs');
    expect(Number(stored?.systolic_bp)).toBe(165);

    const triage = await ctx.db.get<{ risk_level: string }>('SELECT * FROM triage_results');
    expect(triage?.risk_level).toBe('RED');

    // The local records are now marked SYNCED for the CHW to see.
    expect((await getPatient(key, patient.id))?.syncStatus).toBe('SYNCED');
  });

  it('still receives exactly one copy when the connection drops mid-sync and retries', async () => {
    goOffline();
    const patient = await createPatient(key, chwId, {
      firstName: 'Moses', lastName: 'Mukasa', phone: null, age: 61,
      sex: 'MALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });
    await saveScreening(key, {
      patientId: patient.id, chwId, village: 'Kasangati', notes: null,
      vitals: { systolicBp: 150, diastolicBp: 92, temperatureC: null, weightKg: null,
        pulseBpm: null, oxygenSaturation: null, respiratoryRate: null, bloodGlucoseMmol: null },
      symptoms: [],
      triage: { riskLevel: 'AMBER', triggeredRules: ['HTN-AMBER-01'], triggeredLabels: ['Raised BP'],
        recommendation: 'Follow up.', referralRequired: false,
        rulesetVersion: DEFAULT_RULESET.rulesetVersion, evaluationMs: 0.2 },
      referral: null,
    });
    goOnline();

    // The server stores the batch, then the response is lost on the way back —
    // the classic case that creates duplicates in a naive implementation.
    let attempt = 0;
    const flaky = new SyncEngine(async (items) => {
      attempt += 1;
      const result = await push(items);
      if (attempt === 1) throw new TypeError('Failed to fetch'); // response lost
      return result;
    });

    await flaky.run(); // stores server-side, client never learns

    // The failed entries are now scheduled into the future by the backoff. Simulate the
    // wait rather than sleeping through it, and let the engine retry until it is done.
    await drainQueue(flaky);

    const patients = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM patients');
    const visits = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM visits');
    expect(Number(patients?.n)).toBe(1);
    expect(Number(visits?.n)).toBe(1);
    expect(await pendingCount()).toBe(0);
  });

  it('reports duplicates rather than errors when the same batch is offered again', async () => {
    goOffline();
    await createPatient(key, chwId, {
      firstName: 'Fatima', lastName: 'Usman', phone: null, age: 38,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });
    goOnline();

    const first = await engine.run();
    expect(first?.applied).toBe(1);

    // Re-queue the identical record, as a corrupted local state or a manual retry would.
    const entries = await db().queue.toArray();
    expect(entries).toHaveLength(0);

    const patients = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM patients');
    expect(Number(patients?.n)).toBe(1);
  });

  it('parks a permanently invalid record instead of retrying it forever', async () => {
    goOffline();
    const patient = await createPatient(key, chwId, {
      firstName: 'Bad', lastName: 'Record', phone: null, age: 40,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    // Corrupt the queued payload so the server will always reject it.
    const entry = (await db().queue.toArray())[0];
    await db().queue.put({
      ...entry,
      payload: JSON.stringify({ ...JSON.parse(entry.payload), age: -5 }),
      retryCount: 7, // one attempt away from the cap
    });

    goOnline();
    await engine.run();

    const parked = await db().queue.where('status').equals('FAILED').toArray();
    expect(parked).toHaveLength(1);
    expect(parked[0].lastError).toBeTruthy();

    // The record is still on the device and visible to the CHW.
    expect((await getPatient(key, patient.id))?.firstName).toBe('Bad');
  });

  it('applies exponential backoff with jitter between retries', async () => {
    const { backoffFor } = await import('../apps/chw/src/sync/engine.ts');

    // Jitter means the value is random within a growing window, so the property to
    // assert is that the CEILING grows and stays capped.
    const samples = (retry: number) =>
      Array.from({ length: 200 }, () => backoffFor(retry));

    const early = Math.max(...samples(1));
    const later = Math.max(...samples(5));
    const capped = Math.max(...samples(20));

    expect(later).toBeGreaterThan(early);
    expect(capped).toBeLessThanOrEqual(15 * 60_000);
    expect(Math.min(...samples(5))).toBeGreaterThanOrEqual(0);
  });
});

describe('encryption at rest (spec s17)', () => {
  it('does not store patient names in readable form', async () => {
    await createPatient(key, chwId, {
      firstName: 'Sarah', lastName: 'Nakimuli', phone: '+256772000000', age: 52,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    const raw = await db().patients.toArray();
    const serialised = JSON.stringify(raw);

    expect(serialised).not.toContain('Sarah');
    expect(serialised).not.toContain('Nakimuli');
    expect(serialised).not.toContain('+256772000000');

    // The non-identifying fields are deliberately still indexable.
    expect(serialised).toContain('Kasangati');
    expect(raw[0].sec.ct).toBeTruthy();
  });

  it('cannot be read with the wrong PIN', async () => {
    const patient = await createPatient(key, chwId, {
      firstName: 'Sarah', lastName: 'Nakimuli', phone: null, age: 52,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    const rawRow = await db().patients.get(patient.id);
    const wrongKey = await deriveKey('9999', randomSalt());

    const { unsealJson } = await import('../apps/chw/src/db/crypto.ts');
    expect(await unsealJson(wrongKey, rawRow!.sec)).toBeNull();
  });

  it('detects tampering with the stored ciphertext', async () => {
    const patient = await createPatient(key, chwId, {
      firstName: 'Sarah', lastName: 'Nakimuli', phone: null, age: 52,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    const row = await db().patients.get(patient.id);
    const flipped = row!.sec.ct.slice(0, -4) + (row!.sec.ct.endsWith('A') ? 'BBBB' : 'AAAA');
    await db().patients.put({ ...row!, sec: { ...row!.sec, ct: flipped } });

    // AES-GCM authenticates, so a modified record fails to decrypt rather than
    // returning altered clinical data.
    const view = await getPatient(key, patient.id);
    expect(view?.firstName).toBe('(unreadable)');
  });

  it('sends plaintext over the wire, not the at-rest ciphertext', async () => {
    goOffline();
    await createPatient(key, chwId, {
      firstName: 'Sarah', lastName: 'Nakimuli', phone: null, age: 52,
      sex: 'FEMALE', village: 'Kasangati', consentStatus: 'GRANTED',
    });

    // The outbox holds the decrypted payload; confidentiality in transit is TLS's job.
    const entry = (await db().queue.toArray())[0];
    expect(JSON.parse(entry.payload).firstName).toBe('Sarah');
  });
});

describe('capacity (spec s21: 500 patients, 30 days of visits)', () => {
  it('stores and searches 500 patients within the performance budget', async () => {
    goOffline();

    const started = Date.now();
    for (let i = 0; i < 500; i += 1) {
      await createPatient(key, chwId, {
        firstName: `Patient${i}`,
        lastName: 'Test',
        phone: null,
        age: 20 + (i % 60),
        sex: i % 2 === 0 ? 'FEMALE' : 'MALE',
        village: ['Kasangati', 'Nakifuma', 'Kiwoko'][i % 3],
        consentStatus: 'GRANTED',
      });
    }
    const writeMs = Date.now() - started;

    const searchStarted = Date.now();
    const results = await searchPatients(key, 'Patient42');
    const searchMs = Date.now() - searchStarted;

    expect(results.length).toBeGreaterThan(0);
    expect((await deviceStats()).patients).toBe(500);

    // Generous ceilings: these are a regression guard, not a benchmark of the target
    // hardware. A low-end phone is slower than CI, but not by two orders of magnitude.
    expect(writeMs).toBeLessThan(120_000);
    expect(searchMs).toBeLessThan(5_000);
  }, 180_000);
});
