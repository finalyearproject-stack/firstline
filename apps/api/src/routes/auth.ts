/**
 * Authentication routes.
 */
import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { loginSchema } from '@rhm/shared';
import { config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { issueToken } from '../auth/jwt.ts';
import { hashPassword, verifyPassword } from '../auth/passwords.ts';
import { authed, requireAuth } from '../auth/middleware.ts';
import { ApiError, asyncRoute } from '../middleware/errors.ts';
import { createRateLimiter, loginKey } from '../middleware/rateLimit.ts';
import { AUDIT_ACTIONS, recordAuditSafely } from '../services/audit.ts';
import { findUser, findUserByUsername } from '../services/repositories.ts';

export function authRoutes(db: Db): Router {
  const router = Router();

  const loginLimiter = createRateLimiter({
    windowMs: config.rateLimit.loginWindowMs,
    max: config.rateLimit.loginMax,
    keyFor: loginKey,
    message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
  });

  router.post(
    '/login',
    loginLimiter,
    asyncRoute(async (req: Request, res) => {
      const { username, password } = loginSchema.parse(req.body);
      const user = await findUserByUsername(db, username);

      // One generic message for "no such user", "wrong password" and "suspended", and
      // a password verification on a dummy hash when the user does not exist, so the
      // endpoint does not leak which usernames are real through its response timing.
      const invalid = ApiError.unauthenticated('Incorrect username or password.');

      if (!user) {
        await verifyPassword(password, await dummyHash());
        await recordAuditSafely(db, {
          userId: null,
          action: AUDIT_ACTIONS.LOGIN_FAILURE,
          entityType: 'user',
          metadata: { failureReason: 'UNKNOWN_USER' },
          ipAddress: req.ip ?? null,
        });
        throw invalid;
      }

      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok || user.status !== 'ACTIVE') {
        await recordAuditSafely(db, {
          userId: user.id,
          action: AUDIT_ACTIONS.LOGIN_FAILURE,
          entityType: 'user',
          entityId: user.id,
          metadata: { failureReason: ok ? 'SUSPENDED' : 'BAD_PASSWORD' },
          ipAddress: req.ip ?? null,
        });
        throw invalid;
      }

      const { token, expiresAt } = issueToken(user);

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.LOGIN_SUCCESS,
        entityType: 'user',
        entityId: user.id,
        metadata: { role: user.role },
        ipAddress: req.ip ?? null,
      });

      res.json({
        token,
        expiresAt,
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          role: user.role,
          chwIdentifier: user.chwIdentifier,
          village: user.village,
        },
      });
    }),
  );

  /** Returns the signed-in user; used by both clients to restore a session. */
  router.get(
    '/me',
    requireAuth,
    asyncRoute(async (req, res) => {
      const current = authed(req);
      const user = await findUser(db, current.id);
      if (!user) throw ApiError.unauthenticated('Your account no longer exists.');
      if (user.status !== 'ACTIVE') throw ApiError.forbidden('Your account is suspended.');
      res.json({ user });
    }),
  );

  router.post(
    '/logout',
    requireAuth,
    asyncRoute(async (req, res) => {
      // Tokens are stateless, so logout is a client-side discard. It is still audited,
      // because "when did this user stop working" is a question the audit trail
      // should be able to answer.
      const current = authed(req);
      await recordAuditSafely(db, {
        userId: current.id,
        action: AUDIT_ACTIONS.LOGOUT,
        entityType: 'user',
        entityId: current.id,
        ipAddress: req.ip ?? null,
      });
      res.json({ ok: true });
    }),
  );

  return router;
}

/**
 * A real scrypt hash of a random secret, used only to equalise response time on the
 * unknown-username path so the endpoint does not leak which usernames exist.
 *
 * It is derived at the CONFIGURED cost, not a fixed one: a dummy hash that is eight
 * times cheaper than a real one would advertise the unknown-username case precisely as
 * loudly as skipping the verification altogether. It matches no password, because the
 * input is 32 random bytes that are never retained.
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString('hex'));
  return dummyHashPromise;
}
