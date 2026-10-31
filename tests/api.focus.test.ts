/**
 * Screening focus and VHT-kit measurements end to end: synchronised from the phone,
 * stored, returned, counted on the dashboard, and accepted from older app versions
 * that do not send them. Also the boot step that keeps an unapproved deployment on the
 * newest shipped rule template.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuid } from '@rhm/shared';
import { DEFAULT_RULESET } from '@rhm/triage';
import { installShippedRuleSet, loadActiveRuleSet } from '../apps/api/src/routes/clinical.ts';
import { fromBool } from '../apps/api/src/db/index.ts';
import {
  bearer,
  buildPatient,
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
let chwToken: string;
let officerToken: string;

beforeEach(async () => {
  ctx = await createTestContext();
  chw = await createTestUser(ctx.db, { username: 'chw1', role: 'CHW', village: 'Kasangati' });
  await createTestUser(ctx.db, { username: 'officer1', role: 'OFFICIAL' });
  chwToken = await login(ctx.app, 'chw1');
  officerToken = await login(ctx.app, 'officer1');
});

afterEach(async () => {
  await ctx.close();
});

/** Syncs one screening and returns its ids. */
async function syncScreening(visitOverrides: Record<string, unknown>, vitalsOverrides: Record<string, unknown>, risk = 'AMBER') {
  const patient = buildPatient(chw.id, { age: 3 });
  const visit = buildVisit(patient.id, chw.id, visitOverrides);
  const vitals = buildVitals(visit.id, { systolicBp: null, diastolicBp: null, ...vitalsOverrides });
  const triage = buildTriage(visit.id, { riskLevel: risk });

  const response = await request(ctx.app)
    .post('/api/v1/sync')
    .set(bearer(chwToken))
    .send({
      clientTime: new Date().toISOString(),
      items: [syncItem('patient', patient), syncItem('visit', visit), syncItem('vitals', vitals), syncItem('triage', triage)],
    })
    .expect(200);

  return { patient, visit, results: response.body.data.results as Array<{ status: string; message: string | null }> };
}

describe('screening focus and kit measurements', () => {
  it('stores the focus and the MUAC, malaria test, swelling and pregnancy readings', async () => {
    const { patient, results } = await syncScreening(
      { focus: 'CHILD' },
      { muacColour: 'RED', malariaRdt: 'POSITIVE', oedema: false, respiratoryRate: 46 },
    );
    expect(results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);

    const history = await request(ctx.app)
      .get(`/api/v1/patients/${patient.id}/visits`)
      .set(bearer(chwToken))
      .expect(200);
    const [bundle] = history.body.data.visits;
    expect(bundle.visit.focus).toBe('CHILD');
    expect(bundle.vitals).toMatchObject({ muacColour: 'RED', malariaRdt: 'POSITIVE', oedema: false, respiratoryRate: 46, pregnancyWeeks: null });
  });

  it('still accepts a screening from an older app that sends none of the new fields', async () => {
    const { patient, results } = await syncScreening({}, {});
    expect(results.every((r) => r.status === 'APPLIED')).toBe(true);

    const history = await request(ctx.app).get(`/api/v1/patients/${patient.id}/visits`).set(bearer(chwToken)).expect(200);
    const [bundle] = history.body.data.visits;
    expect(bundle.visit.focus).toBeNull();
    expect(bundle.vitals.muacColour).toBeNull();
    expect(bundle.vitals.oedema).toBeNull();
  });

  it('rejects readings the kit cannot produce', async () => {
    const { results } = await syncScreening({ focus: 'PREGNANCY' }, { muacColour: 'BLUE', pregnancyWeeks: 60 });
    const vitals = results[2];
    expect(vitals.status).toBe('REJECTED');
  });

  it('counts screenings by focus and result for the district, older visits as general checks', async () => {
    await syncScreening({ focus: 'FEVER' }, { malariaRdt: 'POSITIVE' }, 'AMBER');
    await syncScreening({ focus: 'FEVER' }, { malariaRdt: 'NEGATIVE' }, 'GREEN');
    await syncScreening({ focus: 'CHILD' }, { muacColour: 'RED' }, 'RED');
    await syncScreening({}, {}, 'GREEN');

    const response = await request(ctx.app).get('/api/v1/dashboard/triage?days=30').set(bearer(officerToken)).expect(200);
    const byFocus = Object.fromEntries(
      (response.body.data.byFocus as Array<{ focus: string }>).map((f) => [f.focus, f]),
    );
    expect(byFocus.FEVER).toEqual({ focus: 'FEVER', visits: 2, red: 0, amber: 1, green: 1 });
    expect(byFocus.CHILD).toMatchObject({ visits: 1, red: 1 });
    expect(byFocus.GENERAL).toMatchObject({ visits: 1, green: 1 });
  });
});

describe('shipped rule template at boot', () => {
  async function insertRuleSet(version: string, active: boolean, approvedBy: string | null) {
    await ctx.db.run(
      'INSERT INTO triage_rulesets (id, version, definition, active, approved_by, approved_on, created_by, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        uuid(), version, JSON.stringify({ ...DEFAULT_RULESET, rulesetVersion: version, rules: DEFAULT_RULESET.rules.slice(0, 23) }),
        fromBool(active), approvedBy, approvedBy ? '2026-10-01' : null, null, new Date().toISOString(),
      ],
    );
  }

  it('moves an unapproved deployment from an older template to the shipped one', async () => {
    await insertRuleSet('1.0.0-TEMPLATE', true, null);

    expect(await installShippedRuleSet(ctx.db)).toBe(DEFAULT_RULESET.rulesetVersion);
    const active = await loadActiveRuleSet(ctx.db);
    expect(active.rulesetVersion).toBe(DEFAULT_RULESET.rulesetVersion);
    expect(active.rules).toHaveLength(DEFAULT_RULESET.rules.length);

    // Idempotent: a second boot changes nothing.
    expect(await installShippedRuleSet(ctx.db)).toBeNull();
  });

  it('never replaces a rule set a clinical authority has approved', async () => {
    await insertRuleSet('2.0.0-DISTRICT', true, 'District Health Officer');

    expect(await installShippedRuleSet(ctx.db)).toBeNull();
    expect((await loadActiveRuleSet(ctx.db)).rulesetVersion).toBe('2.0.0-DISTRICT');
  });
});
