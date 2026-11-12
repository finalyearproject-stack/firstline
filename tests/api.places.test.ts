/**
 * Location hierarchy (district > sub-county > parish > village) and per-patient care
 * status set by a nurse.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  bearer,
  buildPatient,
  buildReferral,
  buildTriage,
  buildVisit,
  buildVitals,
  createTestContext,
  createTestUser,
  login,
  type TestContext,
  type TestUser,
} from './helpers/harness.ts';

let ctx: TestContext;
let chw: TestUser;
let chwToken: string;
let nurseToken: string;
let officerToken: string;
let adminToken: string;

const PLACES = [
  { village: 'Kasangati', parish: 'Kasangati', subCounty: 'Nangabo', district: 'Wakiso' },
  { village: 'Kiwoko', parish: 'Kiwoko', subCounty: 'Kiwoko Town Council', district: 'Nakaseke' },
  { village: 'Ngoma', parish: 'Ngoma', subCounty: 'Ngoma', district: 'Nakaseke' },
];

/** Registers a patient in a village and records one screening with a referral. */
async function screened(village: string, firstName: string, risk: 'RED' | 'AMBER' | 'GREEN' = 'RED') {
  const patient = buildPatient(chw.id, { village, firstName });
  await request(ctx.app).post('/api/v1/patients').set(bearer(chwToken)).send(patient).expect(201);
  const visit = buildVisit(patient.id, chw.id, { village });
  await request(ctx.app)
    .post('/api/v1/visits')
    .set(bearer(chwToken))
    .send({
      visit,
      vitals: buildVitals(visit.id),
      triage: buildTriage(visit.id, { riskLevel: risk }),
      referral: buildReferral(patient.id, visit.id, chw.id),
    })
    .expect(201);
  return patient;
}

beforeEach(async () => {
  ctx = await createTestContext();
  chw = await createTestUser(ctx.db, { username: 'chw1', role: 'CHW', village: 'Kasangati' });
  await createTestUser(ctx.db, { username: 'nurse1', role: 'NURSE' });
  await createTestUser(ctx.db, { username: 'officer1', role: 'OFFICIAL' });
  await createTestUser(ctx.db, { username: 'admin1', role: 'ADMIN' });
  chwToken = await login(ctx.app, 'chw1');
  nurseToken = await login(ctx.app, 'nurse1');
  officerToken = await login(ctx.app, 'officer1');
  adminToken = await login(ctx.app, 'admin1');

  for (const place of PLACES) {
    await request(ctx.app).post('/api/v1/reference/locations').set(bearer(adminToken)).send(place).expect(201);
  }
});

afterEach(async () => {
  await ctx.close();
});

describe('locations', () => {
  it('lists placed villages and the names nobody has placed yet', async () => {
    await screened('Bombo', 'Unplaced');
    const res = await request(ctx.app).get('/api/v1/reference/locations').set(bearer(officerToken)).expect(200);
    expect(res.body.data.locations).toHaveLength(3);
    expect(res.body.data.unplaced).toEqual(['Bombo']);
  });

  it('lets only an administrator place a village', async () => {
    const place = { village: 'Bombo', parish: 'Bombo', subCounty: 'Bombo Town Council', district: 'Luweero' };
    await request(ctx.app).post('/api/v1/reference/locations').set(bearer(nurseToken)).send(place).expect(403);
    await request(ctx.app).post('/api/v1/reference/locations').set(bearer(officerToken)).send(place).expect(403);
    await request(ctx.app).post('/api/v1/reference/locations').set(bearer(adminToken)).send(place).expect(201);
  });

  it('moves a village to another parish when it is placed again', async () => {
    await request(ctx.app).post('/api/v1/reference/locations').set(bearer(adminToken))
      .send({ ...PLACES[2], parish: 'Kyetume' }).expect(201);
    const res = await request(ctx.app).get('/api/v1/reference/locations').set(bearer(adminToken)).expect(200);
    expect(res.body.data.locations.find((l: { village: string }) => l.village === 'Ngoma').parish).toBe('Kyetume');
  });

  it('filters village figures by district and labels each village with its place', async () => {
    await screened('Kasangati', 'Amina');
    await screened('Kiwoko', 'Grace');
    await screened('Ngoma', 'Joan');

    const all = await request(ctx.app).get('/api/v1/dashboard/villages').set(bearer(officerToken)).expect(200);
    expect(all.body.data).toHaveLength(3);

    const nakaseke = await request(ctx.app)
      .get('/api/v1/dashboard/villages?district=Nakaseke')
      .set(bearer(officerToken))
      .expect(200);
    expect(nakaseke.body.data.map((v: { village: string }) => v.village).sort()).toEqual(['Kiwoko', 'Ngoma']);
    expect(nakaseke.body.data[0]).toMatchObject({ district: 'Nakaseke' });

    const ngoma = await request(ctx.app)
      .get('/api/v1/dashboard/villages?district=Nakaseke&subCounty=Ngoma')
      .set(bearer(officerToken))
      .expect(200);
    expect(ngoma.body.data.map((v: { village: string }) => v.village)).toEqual(['Ngoma']);
  });

  it('ignores an empty filter instead of matching nothing', async () => {
    await screened('Kasangati', 'Amina');
    const res = await request(ctx.app)
      .get('/api/v1/dashboard/villages?district=&parish=')
      .set(bearer(officerToken))
      .expect(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('filters referrals by place and by patient name', async () => {
    await screened('Kasangati', 'Amina');
    await screened('Kiwoko', 'Grace');

    const wakiso = await request(ctx.app).get('/api/v1/referrals?district=Wakiso').set(bearer(nurseToken)).expect(200);
    expect(wakiso.body.data).toHaveLength(1);
    expect(wakiso.body.data[0].place).toMatchObject({ parish: 'Kasangati', subCounty: 'Nangabo', district: 'Wakiso' });

    const byName = await request(ctx.app).get('/api/v1/referrals?search=grac').set(bearer(nurseToken)).expect(200);
    expect(byName.body.data.map((r: { patient: { firstName: string } }) => r.patient.firstName)).toEqual(['Grace']);
  });
});

describe('patient status', () => {
  it('lets a nurse set one patient’s status, keeping the history', async () => {
    const patient = await screened('Kasangati', 'Amina');

    await request(ctx.app).post(`/api/v1/patients/${patient.id}/status`).set(bearer(nurseToken))
      .send({ status: 'SEEN', note: 'Came in on Monday' }).expect(201);
    await request(ctx.app).post(`/api/v1/patients/${patient.id}/status`).set(bearer(nurseToken))
      .send({ status: 'RECOVERED' }).expect(201);

    const res = await request(ctx.app).get(`/api/v1/patients/${patient.id}/status`).set(bearer(nurseToken)).expect(200);
    expect(res.body.data.history.map((h: { status: string }) => h.status)).toEqual(['RECOVERED', 'SEEN']);
    expect(res.body.data.history[1].note).toBe('Came in on Monday');
    expect(res.body.data.place).toMatchObject({ district: 'Wakiso' });
  });

  it('refuses status changes from anyone but a nurse', async () => {
    const patient = await screened('Kasangati', 'Amina');
    for (const token of [chwToken, officerToken, adminToken]) {
      await request(ctx.app).post(`/api/v1/patients/${patient.id}/status`).set(bearer(token))
        .send({ status: 'SEEN' }).expect(403);
    }
  });

  it('rejects a status that is not on the list', async () => {
    const patient = await screened('Kasangati', 'Amina');
    await request(ctx.app).post(`/api/v1/patients/${patient.id}/status`).set(bearer(nurseToken))
      .send({ status: 'CURED' }).expect(400);
  });

  it('does not bump the patient’s version, so the VHT’s next upload is not a conflict', async () => {
    const patient = await screened('Kasangati', 'Amina');
    await request(ctx.app).post(`/api/v1/patients/${patient.id}/status`).set(bearer(nurseToken))
      .send({ status: 'SEEN' }).expect(201);
    const row = await ctx.db.get<{ version: number }>('SELECT version FROM patients WHERE id = ?', [patient.id]);
    expect(Number(row?.version)).toBe(1);
  });

  it('keeps the note out of the audit log', async () => {
    const patient = await screened('Kasangati', 'Amina');
    await request(ctx.app).post(`/api/v1/patients/${patient.id}/status`).set(bearer(nurseToken))
      .send({ status: 'ON_TREATMENT', note: 'Amina started treatment' }).expect(201);
    const rows = await ctx.db.all<{ metadata: string }>(
      "SELECT metadata FROM audit_logs WHERE action = 'PATIENT_STATUS_SET'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).not.toContain('Amina');
  });

  it('lists patients for the nurse with their current status, by place and by status', async () => {
    const amina = await screened('Kasangati', 'Amina', 'RED');
    await screened('Kiwoko', 'Grace', 'AMBER');
    await request(ctx.app).post(`/api/v1/patients/${amina.id}/status`).set(bearer(nurseToken))
      .send({ status: 'SEEN' }).expect(201);

    const all = await request(ctx.app).get('/api/v1/patients/care').set(bearer(nurseToken)).expect(200);
    expect(all.body.data).toHaveLength(2);
    // Not yet reviewed comes first.
    expect(all.body.data[0]).toMatchObject({ firstName: 'Grace', status: null, lastRisk: 'AMBER', openReferrals: 1 });
    expect(all.body.data[1]).toMatchObject({ firstName: 'Amina', status: 'SEEN' });
    expect(all.body.data[1].place).toMatchObject({ district: 'Wakiso' });

    const seen = await request(ctx.app).get('/api/v1/patients/care?status=SEEN').set(bearer(nurseToken)).expect(200);
    expect(seen.body.data.map((p: { firstName: string }) => p.firstName)).toEqual(['Amina']);

    const notReviewed = await request(ctx.app).get('/api/v1/patients/care?status=NOT_REVIEWED').set(bearer(nurseToken)).expect(200);
    expect(notReviewed.body.data.map((p: { firstName: string }) => p.firstName)).toEqual(['Grace']);

    const nakaseke = await request(ctx.app).get('/api/v1/patients/care?district=Nakaseke').set(bearer(nurseToken)).expect(200);
    expect(nakaseke.body.data.map((p: { firstName: string }) => p.firstName)).toEqual(['Grace']);
  });

  it('keeps the identifiable patient list from district officials and administrators', async () => {
    await request(ctx.app).get('/api/v1/patients/care').set(bearer(officerToken)).expect(403);
    await request(ctx.app).get('/api/v1/patients/care').set(bearer(adminToken)).expect(403);
    await request(ctx.app).get('/api/v1/patients/care').set(bearer(chwToken)).expect(403);
  });
});
