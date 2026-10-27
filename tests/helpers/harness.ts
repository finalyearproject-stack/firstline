/**
 * Test harness.
 *
 * Builds a real Express application over a real (in-memory) database and a real
 * migration run. Nothing about the API is mocked: the tests exercise the same routes,
 * middleware, validation and SQL that run in production, so a passing test means the
 * system works rather than that the test doubles agree with each other.
 */
import type { Express } from 'express';
import { uuid, type Role } from '@rhm/shared';
import { createApp } from '../../apps/api/src/app.ts';
import { createDb, type Db } from '../../apps/api/src/db/index.ts';
import { migrate } from '../../apps/api/src/db/migrate.ts';
import { hashPassword } from '../../apps/api/src/auth/passwords.ts';

export interface TestContext {
  db: Db;
  app: Express;
  close(): Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const db = await createDb({ dialect: 'sqlite', path: ':memory:' });
  await migrate(db, () => {});
  const app = createApp(db);

  return {
    db,
    app,
    close: () => db.close(),
  };
}

export const TEST_PASSWORD = 'TestPassword2026';

export interface TestUser {
  id: string;
  username: string;
  role: Role;
  village: string | null;
}

export async function createTestUser(
  db: Db,
  overrides: Partial<TestUser> & { username: string; role: Role },
): Promise<TestUser> {
  const id = overrides.id ?? uuid();
  const now = new Date().toISOString();

  await db.run(
    'INSERT INTO users (id, name, phone, username, password_hash, role, chw_identifier, village, status, created_at, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      `Test ${overrides.username}`,
      null,
      overrides.username,
      await hashPassword(TEST_PASSWORD),
      overrides.role,
      overrides.role === 'CHW' ? `CHW-${overrides.username}` : null,
      overrides.village ?? null,
      'ACTIVE',
      now,
      now,
    ],
  );

  return {
    id,
    username: overrides.username,
    role: overrides.role,
    village: overrides.village ?? null,
  };
}

/** Signs in through the real login route and returns the bearer token. */
export async function login(app: Express, username: string, password = TEST_PASSWORD): Promise<string> {
  const request = (await import('supertest')).default;
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ username, password })
    .expect(200);
  return response.body.token as string;
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

export function buildPatient(createdBy: string, overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as string) ?? uuid();
  return {
    id,
    localId: `T-${id.slice(0, 4).toUpperCase()}`,
    firstName: 'Sarah',
    lastName: 'Test',
    age: 52,
    sex: 'FEMALE',
    village: 'Kasangati',
    phone: '+256700000000',
    consentStatus: 'GRANTED',
    createdBy,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    version: 1,
    ...overrides,
  };
}

export function buildVisit(patientId: string, chwId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    patientId,
    chwId,
    visitDate: nowIso(),
    village: 'Kasangati',
    notes: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    version: 1,
    ...overrides,
  };
}

export function buildVitals(visitId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    visitId,
    systolicBp: 165,
    diastolicBp: 100,
    temperatureC: 36.8,
    weightKg: 68,
    pulseBpm: 88,
    oxygenSaturation: null,
    respiratoryRate: null,
    bloodGlucoseMmol: null,
    recordedAt: nowIso(),
    ...overrides,
  };
}

export function buildSymptom(visitId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    visitId,
    symptomCode: 'headache',
    symptomName: 'Headache',
    severity: 'MODERATE',
    durationDays: 3,
    ...overrides,
  };
}

export function buildTriage(visitId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    visitId,
    riskLevel: 'RED',
    triggeredRules: ['HTN-RED-01'],
    triggeredLabels: ['Very high blood pressure together with a persistent headache'],
    recommendation: 'Refer the patient to the health facility immediately.',
    referralRequired: true,
    rulesetVersion: '1.0.0-TEMPLATE',
    evaluationMs: 0.4,
    createdAt: nowIso(),
    ...overrides,
  };
}

export function buildReferral(
  patientId: string,
  visitId: string,
  createdBy: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: uuid(),
    patientId,
    visitId,
    destination: 'Kasangati Health Centre IV',
    urgency: 'IMMEDIATE',
    reason: 'Raised blood pressure with persistent headache',
    status: 'PENDING',
    followUpDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    notes: null,
    createdBy,
    createdAt: nowIso(),
    completedAt: null,
    version: 1,
    ...overrides,
  };
}

/** Wraps an entity as a sync envelope item with a deterministic idempotency key. */
export function syncItem(
  entityType: string,
  payload: Record<string, unknown>,
  operation: 'CREATE' | 'UPDATE' = 'CREATE',
) {
  return {
    entityType,
    entityId: payload.id as string,
    operation,
    idempotencyKey: `${entityType}:${payload.id}:${operation}:${payload.version ?? 1}`,
    payload,
  };
}
