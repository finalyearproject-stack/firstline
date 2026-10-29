/**
 * Clinical endpoint, privacy and analytics tests (spec s14, s16, s18, s24).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { auditSmsBody, composeReferralSms, SMS_FORBIDDEN_TERMS, uuid } from '@rhm/shared';
import { DEFAULT_RULESET } from '@rhm/triage';
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
let chwToken: string;
let nurseToken: string;
let officerToken: string;
let adminToken: string;

beforeEach(async () => {
  ctx = await createTestContext();
  chw = await createTestUser(ctx.db, { username: 'chw1', role: 'CHW', village: 'Kasangati' });
  otherChw = await createTestUser(ctx.db, { username: 'chw2', role: 'CHW', village: 'Nakifuma' });
  await createTestUser(ctx.db, { username: 'nurse1', role: 'NURSE' });
  await createTestUser(ctx.db, { username: 'officer1', role: 'OFFICIAL' });
  await createTestUser(ctx.db, { username: 'admin1', role: 'ADMIN' });

  chwToken = await login(ctx.app, 'chw1');
  nurseToken = await login(ctx.app, 'nurse1');
  officerToken = await login(ctx.app, 'officer1');
  adminToken = await login(ctx.app, 'admin1');
});

afterEach(async () => {
  await ctx.close();
});

// ---------------------------------------------------------------------------

describe('patients', () => {
  it('creates and reads a patient back', async () => {
    const created = await request(ctx.app)
      .post('/api/v1/patients')
      .set(bearer(chwToken))
      .send(buildPatient(chw.id, { firstName: 'Sarah', lastName: 'Nakimuli' }))
      .expect(201);

    expect(created.body.data).toMatchObject({ firstName: 'Sarah', village: 'Kasangati', version: 1 });

    const fetched = await request(ctx.app)
      .get(`/api/v1/patients/${created.body.data.id}`)
      .set(bearer(chwToken))
      .expect(200);

    expect(fetched.body.data.lastName).toBe('Nakimuli');
  });

  it('rejects an out-of-range age', async () => {
    await request(ctx.app)
      .post('/api/v1/patients')
      .set(bearer(chwToken))
      .send(buildPatient(chw.id, { age: 200 }))
      .expect(400);
  });

  it('scopes the list to the CHW who registered each patient', async () => {
    await request(ctx.app).post('/api/v1/patients').set(bearer(chwToken))
      .send(buildPatient(chw.id, { firstName: 'Mine' })).expect(201);

    const otherToken = await login(ctx.app, 'chw2');
    await request(ctx.app).post('/api/v1/patients').set(bearer(otherToken))
      .send(buildPatient(otherChw.id, { firstName: 'Theirs', village: 'Nakifuma' })).expect(201);

    const mine = await request(ctx.app).get('/api/v1/patients').set(bearer(chwToken)).expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].firstName).toBe('Mine');

    const nurse = await request(ctx.app).get('/api/v1/patients').set(bearer(nurseToken)).expect(200);
    expect(nurse.body.data).toHaveLength(2);
  });

  it("answers 404, not 403, for another CHW's patient", async () => {
    const otherToken = await login(ctx.app, 'chw2');
    const created = await request(ctx.app).post('/api/v1/patients').set(bearer(otherToken))
      .send(buildPatient(otherChw.id)).expect(201);

    // 403 would confirm the record exists, which is itself information about a person
    // this CHW has no relationship with.
    await request(ctx.app)
      .get(`/api/v1/patients/${created.body.data.id}`)
      .set(bearer(chwToken))
      .expect(404);
  });

  it('searches by name, code and village', async () => {
    await request(ctx.app).post('/api/v1/patients').set(bearer(chwToken))
      .send(buildPatient(chw.id, { firstName: 'Fatima', lastName: 'Usman' })).expect(201);

    const byName = await request(ctx.app).get('/api/v1/patients?search=fatima').set(bearer(chwToken)).expect(200);
    expect(byName.body.data).toHaveLength(1);

    const noMatch = await request(ctx.app).get('/api/v1/patients?search=zzzz').set(bearer(chwToken)).expect(200);
    expect(noMatch.body.data).toHaveLength(0);
  });

  it('increments the version on update and keeps the server in charge of it', async () => {
    const created = await request(ctx.app).post('/api/v1/patients').set(bearer(chwToken))
      .send(buildPatient(chw.id)).expect(201);

    const updated = await request(ctx.app)
      .put(`/api/v1/patients/${created.body.data.id}`)
      .set(bearer(chwToken))
      // A client claiming version 99 must not be able to set it.
      .send({ village: 'Nakifuma', version: 99 })
      .expect(200);

    expect(updated.body.data.version).toBe(2);
    expect(updated.body.data.village).toBe('Nakifuma');
  });

  it('paginates', async () => {
    for (let i = 0; i < 7; i += 1) {
      await request(ctx.app).post('/api/v1/patients').set(bearer(chwToken))
        .send(buildPatient(chw.id, { firstName: `P${i}` })).expect(201);
    }

    const page = await request(ctx.app)
      .get('/api/v1/patients?page=2&pageSize=3')
      .set(bearer(chwToken))
      .expect(200);

    expect(page.body.data).toHaveLength(3);
    expect(page.body.pagination).toMatchObject({ page: 2, pageSize: 3, total: 7, totalPages: 3 });
  });
});

// ---------------------------------------------------------------------------

describe('visits', () => {
  async function createPatient() {
    const response = await request(ctx.app).post('/api/v1/patients').set(bearer(chwToken))
      .send(buildPatient(chw.id)).expect(201);
    return response.body.data.id as string;
  }

  it('records a whole encounter in one request', async () => {
    const patientId = await createPatient();
    const visit = buildVisit(patientId, chw.id);

    const response = await request(ctx.app)
      .post('/api/v1/visits')
      .set(bearer(chwToken))
      .send({
        visit,
        vitals: buildVitals(visit.id),
        symptoms: [buildSymptom(visit.id)],
        triage: buildTriage(visit.id),
        referral: buildReferral(patientId, visit.id, chw.id),
      })
      .expect(201);

    expect(response.body.data.vitals.systolicBp).toBe(165);
    expect(response.body.data.triage.riskLevel).toBe('RED');
    expect(response.body.data.symptoms).toHaveLength(1);
    expect(response.body.data.referral.urgency).toBe('IMMEDIATE');
  });

  it('stores nothing at all when one part of the encounter is invalid', async () => {
    const patientId = await createPatient();
    const visit = buildVisit(patientId, chw.id);

    await request(ctx.app)
      .post('/api/v1/visits')
      .set(bearer(chwToken))
      .send({
        visit,
        vitals: buildVitals(visit.id, { systolicBp: 9999 }), // invalid
        triage: buildTriage(visit.id),
      })
      .expect(400);

    // The transaction rolled back: no orphan visit, no orphan triage.
    const visits = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM visits');
    const triage = await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM triage_results');
    expect(Number(visits?.n)).toBe(0);
    expect(Number(triage?.n)).toBe(0);
  });

  it('returns the full patient history', async () => {
    const patientId = await createPatient();

    for (const systolic of [150, 165]) {
      const visit = buildVisit(patientId, chw.id);
      await request(ctx.app).post('/api/v1/visits').set(bearer(chwToken))
        .send({ visit, vitals: buildVitals(visit.id, { systolicBp: systolic }), triage: buildTriage(visit.id) })
        .expect(201);
    }

    const history = await request(ctx.app)
      .get(`/api/v1/patients/${patientId}/visits`)
      .set(bearer(chwToken))
      .expect(200);

    expect(history.body.data.visits).toHaveLength(2);
    expect(history.body.data.patient.id).toBe(patientId);
  });
});

// ---------------------------------------------------------------------------

describe('triage endpoint', () => {
  it('reproduces the offline engine’s verdict on the server', async () => {
    const response = await request(ctx.app)
      .post('/api/v1/triage')
      .set(bearer(chwToken))
      .send({
        age: 52,
        systolicBp: 165,
        diastolicBp: 100,
        symptoms: [{ symptomCode: 'headache', severity: 'MODERATE', durationDays: 3 }],
      })
      .expect(200);

    expect(response.body.data.riskLevel).toBe('RED');
    expect(response.body.data.triggeredRules).toContain('HTN-RED-01');
    // The disclaimer travels with every result, so no consumer can present the verdict
    // as clinical authority by accident.
    expect(response.body.data.disclaimer).toMatch(/NOT AN APPROVED CLINICAL PROTOCOL/i);
  });

  it('serves the active rule set for devices to cache', async () => {
    const response = await request(ctx.app)
      .get('/api/v1/triage/ruleset')
      .set(bearer(chwToken))
      .expect(200);

    expect(response.body.data.rulesetVersion).toBe(DEFAULT_RULESET.rulesetVersion);
    expect(response.body.data.rules.length).toBeGreaterThan(0);
  });

  it('lets an administrator publish a new rule set and refuses everyone else', async () => {
    const next = {
      ...DEFAULT_RULESET,
      rulesetVersion: '2.0.0-TEST',
      metadata: { ...DEFAULT_RULESET.metadata, approvedBy: 'Dr A. Reviewer', approvedOn: '2026-09-01' },
    };

    await request(ctx.app).put('/api/v1/triage/ruleset').set(bearer(chwToken)).send(next).expect(403);
    await request(ctx.app).put('/api/v1/triage/ruleset').set(bearer(nurseToken)).send(next).expect(403);
    await request(ctx.app).put('/api/v1/triage/ruleset').set(bearer(adminToken)).send(next).expect(201);

    const active = await request(ctx.app).get('/api/v1/triage/ruleset').set(bearer(chwToken)).expect(200);
    expect(active.body.data.rulesetVersion).toBe('2.0.0-TEST');
    expect(active.body.data.metadata.approvedBy).toBe('Dr A. Reviewer');
  });

  it('refuses to publish a malformed rule set', async () => {
    const broken = {
      ...DEFAULT_RULESET,
      rulesetVersion: '3.0.0-TEST',
      rules: [{ id: 'BAD', riskLevel: 'PURPLE', priority: 1, condition: { fact: 'x', op: 'nope' } }],
    };

    const response = await request(ctx.app)
      .put('/api/v1/triage/ruleset')
      .set(bearer(adminToken))
      .send(broken)
      .expect(400);

    expect(response.body.error.fields.length).toBeGreaterThan(0);

    // The active rule set is unchanged, so devices keep working on the known-good one.
    const active = await request(ctx.app).get('/api/v1/triage/ruleset').set(bearer(chwToken)).expect(200);
    expect(active.body.data.rulesetVersion).toBe(DEFAULT_RULESET.rulesetVersion);
  });

  it('refuses to publish the same version twice', async () => {
    const next = { ...DEFAULT_RULESET, rulesetVersion: '4.0.0-TEST' };
    await request(ctx.app).put('/api/v1/triage/ruleset').set(bearer(adminToken)).send(next).expect(201);
    await request(ctx.app).put('/api/v1/triage/ruleset').set(bearer(adminToken)).send(next).expect(409);
  });
});

// ---------------------------------------------------------------------------

describe('referrals and SMS minimisation (spec s10, s17)', () => {
  async function seedReferral(phone: string | null = '+256772000000') {
    const patient = await request(ctx.app).post('/api/v1/patients').set(bearer(chwToken))
      .send(buildPatient(chw.id, { firstName: 'Sarah', lastName: 'Nakimuli', phone })).expect(201);

    const visit = buildVisit(patient.body.data.id, chw.id);
    const referral = buildReferral(patient.body.data.id, visit.id, chw.id);

    await request(ctx.app).post('/api/v1/visits').set(bearer(chwToken))
      .send({ visit, vitals: buildVitals(visit.id), triage: buildTriage(visit.id), referral })
      .expect(201);

    return referral;
  }

  it('composes a message with no clinical content whatsoever', async () => {
    const referral = await seedReferral();

    const response = await request(ctx.app)
      .post(`/api/v1/referrals/${referral.id}/sms`)
      .set(bearer(chwToken))
      .expect(200);

    const body = response.body.data.body as string;

    expect(body).toContain('Sarah');                 // first name only
    expect(body).toContain('Kasangati Health Centre IV');
    expect(body).not.toContain('Nakimuli');             // no surname
    expect(body).not.toMatch(/165|100/);             // no readings
    expect(auditSmsBody(body)).toEqual([]);          // no forbidden term
  });

  it('keeps every forbidden term out of the composed message', () => {
    const body = composeReferralSms({
      firstName: 'Sarah',
      facility: 'Kasangati Health Centre IV',
      urgency: 'IMMEDIATE',
      referralCode: 'R-7K2M',
      appointmentDate: '2026-10-01',
    });

    for (const term of SMS_FORBIDDEN_TERMS) {
      expect(body.toLowerCase()).not.toContain(term.trim());
    }
  });

  it('refuses when the patient has no phone number on record', async () => {
    const referral = await seedReferral(null);
    await request(ctx.app)
      .post(`/api/v1/referrals/${referral.id}/sms`)
      .set(bearer(chwToken))
      .expect(400);
  });

  it('lets a nurse move a referral through its states and audits each change', async () => {
    const referral = await seedReferral();

    await request(ctx.app).patch(`/api/v1/referrals/${referral.id}`)
      .set(bearer(nurseToken)).send({ status: 'ACKNOWLEDGED' }).expect(200);

    const completed = await request(ctx.app).patch(`/api/v1/referrals/${referral.id}`)
      .set(bearer(nurseToken)).send({ status: 'COMPLETED' }).expect(200);

    expect(completed.body.data.status).toBe('COMPLETED');
    expect(completed.body.data.completedAt).toBeTruthy();

    const audits = await ctx.db.all<{ action: string }>(
      "SELECT action FROM audit_logs WHERE action = 'REFERRAL_UPDATE'",
    );
    expect(audits).toHaveLength(2);
  });

  it('does not let a CHW change referral status', async () => {
    const referral = await seedReferral();
    await request(ctx.app).patch(`/api/v1/referrals/${referral.id}`)
      .set(bearer(chwToken)).send({ status: 'COMPLETED' }).expect(403);
  });
});

// ---------------------------------------------------------------------------

describe('dashboard analytics and the privacy boundary (spec s14, s18)', () => {
  beforeEach(async () => {
    // A small but realistic dataset: two villages, three screenings, one referral.
    for (const [village, systolic, risk] of [
      ['Kasangati', 165, 'RED'],
      ['Kasangati', 150, 'AMBER'],
      ['Nakifuma', 118, 'GREEN'],
    ] as const) {
      const patient = await request(ctx.app).post('/api/v1/patients').set(bearer(chwToken))
        .send(buildPatient(chw.id, { village })).expect(201);

      const visit = buildVisit(patient.body.data.id, chw.id, { village });
      await request(ctx.app).post('/api/v1/visits').set(bearer(chwToken))
        .send({
          visit,
          vitals: buildVitals(visit.id, { systolicBp: systolic }),
          triage: buildTriage(visit.id, { riskLevel: risk, referralRequired: risk === 'RED' }),
          referral: risk === 'RED' ? buildReferral(patient.body.data.id, visit.id, chw.id) : undefined,
        })
        .expect(201);
    }
  });

  it('counts the overview correctly', async () => {
    const response = await request(ctx.app)
      .get('/api/v1/dashboard/overview')
      .set(bearer(officerToken))
      .expect(200);

    expect(response.body.data).toMatchObject({
      totalPatients: 3,
      totalVisits: 3,
      activeChws: 1,
      redAlerts: 1,
      amberAlerts: 1,
      greenScreenings: 1,
    });
  });

  it('reports the preceding period alongside, for like-for-like change', async () => {
    const response = await request(ctx.app)
      .get('/api/v1/dashboard/overview')
      .set(bearer(officerToken))
      .expect(200);

    // Everything in this suite was recorded today, so the window before it is empty.
    expect(response.body.data.previous).toEqual({
      totalPatients: 0,
      totalVisits: 0,
      activeChws: 0,
      redAlerts: 0,
      amberAlerts: 0,
      greenScreenings: 0,
    });
  });

  it('breaks activity down by village', async () => {
    const response = await request(ctx.app)
      .get('/api/v1/dashboard/villages')
      .set(bearer(officerToken))
      .expect(200);

    const kasangati = response.body.data.find((v: { village: string }) => v.village === 'Kasangati');
    expect(kasangati).toMatchObject({ visits: 2, red: 1, amber: 1 });
    expect(kasangati.redRate).toBe(50);
  });

  it('returns a triage trend and a category breakdown', async () => {
    const response = await request(ctx.app)
      .get('/api/v1/dashboard/triage')
      .set(bearer(officerToken))
      .expect(200);

    expect(response.body.data.trend.length).toBeGreaterThan(0);
    const total = response.body.data.trend.reduce(
      (sum: number, point: { RED: number; AMBER: number; GREEN: number }) =>
        sum + point.RED + point.AMBER + point.GREEN,
      0,
    );
    expect(total).toBe(3);
    expect(response.body.data.byCategory.find((c: { category: string }) => c.category === 'HTN')).toBeTruthy();
  });

  it('gives each symptom a time series that adds up to its total', async () => {
    const patient = await request(ctx.app).post('/api/v1/patients').set(bearer(chwToken))
      .send(buildPatient(chw.id, { village: 'Kasangati' })).expect(201);
    const visit = buildVisit(patient.body.data.id, chw.id, { village: 'Kasangati' });
    await request(ctx.app).post('/api/v1/visits').set(bearer(chwToken))
      .send({
        visit,
        vitals: buildVitals(visit.id),
        symptoms: [buildSymptom(visit.id)],
        triage: buildTriage(visit.id),
      })
      .expect(201);

    const response = await request(ctx.app)
      .get('/api/v1/dashboard/symptom-trends?days=30')
      .set(bearer(officerToken))
      .expect(200);

    expect(response.body.data.length).toBeGreaterThan(0);
    for (const trend of response.body.data as Array<{
      current: number;
      previous: number;
      seriesUnit: string;
      series: Array<{ start: string; current: number; previous: number }>;
    }>) {
      // 30 days is bucketed by week; the buckets must account for every occurrence.
      expect(trend.seriesUnit).toBe('week');
      expect(trend.series).toHaveLength(5);
      expect(trend.series.reduce((sum, point) => sum + point.current, 0)).toBe(trend.current);
      expect(trend.series.reduce((sum, point) => sum + point.previous, 0)).toBe(trend.previous);
    }
  });

  it('reports CHW activity', async () => {
    const response = await request(ctx.app)
      .get('/api/v1/dashboard/chws')
      .set(bearer(nurseToken))
      .expect(200);

    const entry = response.body.data.find((c: { chwId: string }) => c.chwId === chw.id);
    expect(entry).toMatchObject({ visits: 3, patients: 3, red: 1 });
  });

  it('NEVER returns identifiable patient data to a district official', async () => {
    // Every aggregate endpoint an official can reach, checked against the names that
    // are definitely in the database.
    const paths = [
      '/api/v1/dashboard/overview',
      '/api/v1/dashboard/villages',
      '/api/v1/dashboard/triage',
      '/api/v1/dashboard/chws',
      '/api/v1/dashboard/referrals',
      '/api/v1/dashboard/screening-volume',
      '/api/v1/dashboard/alerts',
      '/api/v1/dashboard/sync-health',
    ];

    for (const path of paths) {
      const response = await request(ctx.app).get(path).set(bearer(officerToken)).expect(200);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('Sarah');
      expect(serialised).not.toContain('Nakimuli');
      expect(serialised).not.toContain('+256700000000');
    }
  });

  it('refuses an official access to the identifiable endpoints entirely', async () => {
    await request(ctx.app).get('/api/v1/patients').set(bearer(officerToken)).expect(403);
    await request(ctx.app).get('/api/v1/referrals').set(bearer(officerToken)).expect(403);
  });

  it('raises an alert when a village accumulates RED flags', async () => {
    // Three more REDs in Kasangati pushes it over the threshold of four.
    for (let i = 0; i < 3; i += 1) {
      const patient = await request(ctx.app).post('/api/v1/patients').set(bearer(chwToken))
        .send(buildPatient(chw.id, { village: 'Kasangati' })).expect(201);
      const visit = buildVisit(patient.body.data.id, chw.id, { village: 'Kasangati' });
      await request(ctx.app).post('/api/v1/visits').set(bearer(chwToken))
        .send({ visit, vitals: buildVitals(visit.id), triage: buildTriage(visit.id) })
        .expect(201);
    }

    const response = await request(ctx.app)
      .get('/api/v1/dashboard/alerts')
      .set(bearer(officerToken))
      .expect(200);

    const cluster = response.body.data.find((a: { id: string }) => a.id === 'red-cluster-Kasangati');
    expect(cluster).toBeTruthy();
    expect(cluster.severity).toBe('HIGH');
    expect(cluster.title).toMatch(/Kasangati/);
  });
});

// ---------------------------------------------------------------------------

describe('awareness content', () => {
  it('is readable by every role that works with patients', async () => {
    await ctx.db.run(
      'INSERT INTO awareness_content (id, title, language, category, summary, body, audio_path, version, active, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uuid(), 'Hypertension', 'en', 'Hypertension', 'Summary', 'Body text', null, 1, 1, new Date().toISOString()],
    );

    for (const token of [chwToken, nurseToken, adminToken]) {
      const response = await request(ctx.app).get('/api/v1/awareness').set(bearer(token)).expect(200);
      expect(response.body.data).toHaveLength(1);
    }
  });

  it('can only be edited by an administrator', async () => {
    const id = uuid();
    const payload = {
      id,
      title: 'New topic',
      language: 'en',
      category: 'Nutrition',
      summary: 'A summary',
      body: 'The body of the awareness message.',
      audioPath: null,
      version: 1,
      active: true,
    };

    await request(ctx.app).put(`/api/v1/awareness/${id}`).set(bearer(chwToken)).send(payload).expect(403);
    await request(ctx.app).put(`/api/v1/awareness/${id}`).set(bearer(adminToken)).send(payload).expect(200);

    const listed = await request(ctx.app).get('/api/v1/awareness').set(bearer(chwToken)).expect(200);
    expect(listed.body.data.find((i: { id: string }) => i.id === id)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('API conventions', () => {
  it('answers the health and readiness probes without authentication', async () => {
    await request(ctx.app).get('/health').expect(200);
    await request(ctx.app).get('/ready').expect(200);
  });

  it('returns a structured 404 for an unknown route', async () => {
    const response = await request(ctx.app).get('/api/v1/nope').set(bearer(chwToken)).expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('sets the expected security headers', async () => {
    const response = await request(ctx.app).get('/health').expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('exposes rate-limit headers', async () => {
    const response = await request(ctx.app).get('/api/v1/patients').set(bearer(chwToken)).expect(200);
    expect(response.headers['ratelimit-limit']).toBeTruthy();
    expect(response.headers['ratelimit-remaining']).toBeTruthy();
  });

  it('rejects a body that is not valid JSON', async () => {
    await request(ctx.app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{not json')
      .expect(400);
  });
});
