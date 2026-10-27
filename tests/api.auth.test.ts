/**
 * Authentication and authorisation tests (spec s24: authentication logic, authorization).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hashPassword, passwordProblems, verifyPassword } from '../apps/api/src/auth/passwords.ts';
import { issueToken, verifyToken } from '../apps/api/src/auth/jwt.ts';
import { can } from '@rhm/shared';
import {
  bearer,
  createTestContext,
  createTestUser,
  login,
  TEST_PASSWORD,
  type TestContext,
} from './helpers/harness.ts';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
  await createTestUser(ctx.db, { username: 'chw1', role: 'CHW', village: 'Kasangati' });
  await createTestUser(ctx.db, { username: 'nurse1', role: 'NURSE' });
  await createTestUser(ctx.db, { username: 'officer1', role: 'OFFICIAL' });
  await createTestUser(ctx.db, { username: 'admin1', role: 'ADMIN' });
});

afterEach(async () => {
  await ctx.close();
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
  });

  it('produces a different hash each time, so equal passwords are not detectable', async () => {
    const a = await hashPassword(TEST_PASSWORD);
    const b = await hashPassword(TEST_PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(TEST_PASSWORD, a)).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, b)).toBe(true);
  });

  it('never stores the password itself', async () => {
    const hash = await hashPassword('SuperSecret2026');
    expect(hash).not.toContain('SuperSecret2026');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    for (const corrupt of ['', 'garbage', 'scrypt$', 'bcrypt$1$aa$bb', 'scrypt$abc$zz$yy']) {
      expect(await verifyPassword('anything', corrupt)).toBe(false);
    }
  });

  it('enforces the minimum password policy', () => {
    expect(passwordProblems('short')).not.toEqual([]);
    expect(passwordProblems('12345678')).not.toEqual([]);
    expect(passwordProblems('aaaaaaaa')).not.toEqual([]);
    expect(passwordProblems('password')).not.toEqual([]);
    expect(passwordProblems('a-good-long-passphrase')).toEqual([]);
  });
});

describe('JWT', () => {
  const user = { id: '11111111-1111-4111-8111-111111111111', username: 'x', role: 'CHW' as const };

  it('round-trips claims', () => {
    const { token } = issueToken(user);
    const result = verifyToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe(user.id);
      expect(result.claims.role).toBe('CHW');
    }
  });

  it('rejects a tampered payload', () => {
    const { token } = issueToken(user);
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...user, sub: user.id, role: 'ADMIN', exp: 9e9, iat: 1, iss: 'rhm-api' }))
      .toString('base64url');
    const result = verifyToken(`${header}.${forged}.${signature}`);
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects the "alg: none" downgrade', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: user.id, role: 'ADMIN', exp: 9e9, iss: 'rhm-api' }),
    ).toString('base64url');
    expect(verifyToken(`${header}.${payload}.`)).toEqual({ ok: false, reason: 'BAD_ALGORITHM' });
  });

  it('rejects an expired token', () => {
    const { token } = issueToken(user, -10);
    expect(verifyToken(token)).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '...']) {
      expect(() => verifyToken(bad)).not.toThrow();
      expect(verifyToken(bad).ok).toBe(false);
    }
  });
});

describe('POST /auth/login', () => {
  it('issues a token for valid credentials', async () => {
    const res = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'chw1', password: TEST_PASSWORD })
      .expect(200);

    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toMatchObject({ username: 'chw1', role: 'CHW' });
    // The response must never carry the hash.
    expect(JSON.stringify(res.body)).not.toContain('scrypt$');
  });

  it('gives the same message for a wrong password and an unknown user', async () => {
    const wrongPassword = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'chw1', password: 'not-the-password' })
      .expect(401);

    const unknownUser = await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'does-not-exist', password: 'not-the-password' })
      .expect(401);

    expect(wrongPassword.body.error.message).toBe(unknownUser.body.error.message);
  });

  it('refuses a suspended account', async () => {
    await ctx.db.run("UPDATE users SET status = 'SUSPENDED' WHERE username = 'chw1'");
    await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'chw1', password: TEST_PASSWORD })
      .expect(401);
  });

  it('rejects a malformed body with a field-level error', async () => {
    const res = await request(ctx.app).post('/api/v1/auth/login').send({ username: 'x' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields).toBeInstanceOf(Array);
  });

  it('records both successful and failed sign-ins in the audit log', async () => {
    await request(ctx.app).post('/api/v1/auth/login').send({ username: 'chw1', password: TEST_PASSWORD });
    await request(ctx.app)
      .post('/api/v1/auth/login')
      .send({ username: 'chw1', password: 'wrong-but-long-enough' });

    const rows = await ctx.db.all<{ action: string }>('SELECT action FROM audit_logs ORDER BY timestamp');
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('LOGIN_SUCCESS');
    expect(actions).toContain('LOGIN_FAILURE');
  });

  it('rate-limits repeated failed attempts', async () => {
    const attempts = [];
    for (let i = 0; i < 12; i += 1) {
      attempts.push(
        await request(ctx.app)
          .post('/api/v1/auth/login')
          .send({ username: 'chw1', password: `wrong-${i}` }),
      );
    }
    expect(attempts.some((r) => r.status === 429)).toBe(true);
  });
});

describe('role-based access control', () => {
  it('matches the capability matrix in the specification', () => {
    expect(can('CHW', 'patient:create')).toBe(true);
    expect(can('CHW', 'dashboard:aggregate')).toBe(false);
    expect(can('CHW', 'audit:read')).toBe(false);

    expect(can('NURSE', 'referral:update')).toBe(true);
    expect(can('NURSE', 'user:manage')).toBe(false);

    // The privacy boundary: officials see aggregates, never identities.
    expect(can('OFFICIAL', 'dashboard:aggregate')).toBe(true);
    expect(can('OFFICIAL', 'dashboard:identifiable')).toBe(false);
    expect(can('OFFICIAL', 'patient:read:all')).toBe(false);

    expect(can('ADMIN', 'user:manage')).toBe(true);
    expect(can('ADMIN', 'rules:manage')).toBe(true);
    expect(can('ADMIN', 'audit:read')).toBe(true);
  });

  it('refuses an unauthenticated request', async () => {
    await request(ctx.app).get('/api/v1/patients').expect(401);
  });

  it('refuses a request carrying a forged token', async () => {
    await request(ctx.app)
      .get('/api/v1/patients')
      .set(bearer('not.a.token'))
      .expect(401);
  });

  it('enforces the matrix on live routes, not only in the UI', async () => {
    const chw = await login(ctx.app, 'chw1');
    const officer = await login(ctx.app, 'officer1');
    const admin = await login(ctx.app, 'admin1');

    // An official cannot reach identifiable patient data...
    await request(ctx.app).get('/api/v1/patients').set(bearer(officer)).expect(403);
    // ...but can reach aggregates.
    await request(ctx.app).get('/api/v1/dashboard/overview').set(bearer(officer)).expect(200);

    // A CHW cannot reach the dashboard or the audit log.
    await request(ctx.app).get('/api/v1/dashboard/overview').set(bearer(chw)).expect(403);
    await request(ctx.app).get('/api/v1/audit').set(bearer(chw)).expect(403);
    await request(ctx.app).get('/api/v1/users').set(bearer(chw)).expect(403);

    // An administrator can.
    await request(ctx.app).get('/api/v1/audit').set(bearer(admin)).expect(200);
    await request(ctx.app).get('/api/v1/users').set(bearer(admin)).expect(200);
  });

  it('reports an expired session distinctly so the client can prompt a re-login', async () => {
    const { token } = issueToken({ id: 'x', username: 'chw1', role: 'CHW' }, -1);
    const res = await request(ctx.app).get('/api/v1/patients').set(bearer(token)).expect(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });
});

describe('user administration', () => {
  it('refuses to disable the last active administrator', async () => {
    const admin = await login(ctx.app, 'admin1');
    const row = await ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'admin1'");

    const res = await request(ctx.app)
      .patch(`/api/v1/users/${row!.id}`)
      .set(bearer(admin))
      .send({ status: 'SUSPENDED' })
      .expect(409);

    expect(res.body.error.message).toMatch(/last active administrator/i);
  });

  it('never returns a password hash when listing users', async () => {
    const admin = await login(ctx.app, 'admin1');
    const res = await request(ctx.app).get('/api/v1/users').set(bearer(admin)).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('scrypt$');
    expect(res.body.data[0]).not.toHaveProperty('passwordHash');
  });

  it('rejects a weak password when creating a user', async () => {
    const admin = await login(ctx.app, 'admin1');
    await request(ctx.app)
      .post('/api/v1/users')
      .set(bearer(admin))
      .send({ name: 'New CHW', username: 'newchw', password: '12345678', role: 'CHW' })
      .expect(400);
  });
});
