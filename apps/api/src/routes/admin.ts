/**
 * User management and audit-log routes (administrators, plus scoped read for others).
 */
import { Router } from 'express';
import { z } from 'zod';
import { createUserSchema, uuid, ROLES } from '@rhm/shared';
import { fromBool, type Db, type Param } from '../db/index.ts';
import { authed, requireAuth, requireAnyPermission } from '../auth/middleware.ts';
import { ApiError, asyncRoute } from '../middleware/errors.ts';
import { hashPassword, passwordProblems } from '../auth/passwords.ts';
import { AUDIT_ACTIONS, recordAuditSafely } from '../services/audit.ts';
import { mapUser } from '../services/repositories.ts';

export function userRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    requireAnyPermission('user:manage'),
    asyncRoute(async (req, res) => {
      const q = z
        .object({
          role: z.enum(ROLES).optional(),
          status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
          village: z.string().trim().max(120).optional(),
        })
        .parse(req.query);

      const where: string[] = [];
      const params: Param[] = [];
      if (q.role) {
        where.push('role = ?');
        params.push(q.role);
      }
      if (q.status) {
        where.push('status = ?');
        params.push(q.status);
      }
      if (q.village) {
        where.push('village = ?');
        params.push(q.village);
      }

      const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const rows = await db.all(`SELECT * FROM users${clause} ORDER BY role, name`, params);

      // mapUser never reads password_hash, so it cannot be serialised by accident.
      res.json({ data: rows.map(mapUser) });
    }),
  );

  router.post(
    '/',
    requireAnyPermission('user:manage'),
    asyncRoute(async (req, res) => {
      const actor = authed(req);
      const input = createUserSchema.parse(req.body);

      const problems = passwordProblems(input.password);
      if (problems.length > 0) {
        throw ApiError.validation(
          'That password does not meet the minimum policy.',
          problems.map((message) => ({ path: 'password', message })),
        );
      }

      const existing = await db.get('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', [
        input.username,
      ]);
      if (existing) throw ApiError.conflict('That username is already taken.');

      const now = new Date().toISOString();
      const id = uuid();

      await db.run(
        'INSERT INTO users (id, name, phone, username, password_hash, role, chw_identifier, village, status, created_at, updated_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          input.name,
          input.phone ?? null,
          input.username,
          await hashPassword(input.password),
          input.role,
          input.chwIdentifier ?? null,
          input.village ?? null,
          input.status ?? 'ACTIVE',
          now,
          now,
        ],
      );

      await recordAuditSafely(db, {
        userId: actor.id,
        action: AUDIT_ACTIONS.USER_CREATE,
        entityType: 'user',
        entityId: id,
        metadata: { role: input.role, village: input.village ?? null },
        ipAddress: req.ip ?? null,
      });

      const row = await db.get('SELECT * FROM users WHERE id = ?', [id]);
      res.status(201).json({ data: row ? mapUser(row) : null });
    }),
  );

  router.patch(
    '/:id',
    requireAnyPermission('user:manage'),
    asyncRoute(async (req, res) => {
      const actor = authed(req);
      const patch = z
        .object({
          name: z.string().trim().min(2).max(120).optional(),
          phone: z.string().trim().max(32).nullable().optional(),
          role: z.enum(ROLES).optional(),
          chwIdentifier: z.string().trim().max(32).nullable().optional(),
          village: z.string().trim().max(120).nullable().optional(),
          status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
          password: z.string().min(8).max(200).optional(),
        })
        .parse(req.body);

      const row = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
      if (!row) throw ApiError.notFound('User');
      const existing = mapUser(row);

      // An administrator must not be able to lock the system out of itself by
      // suspending or demoting the last active administrator.
      if (
        existing.role === 'ADMIN' &&
        (patch.status === 'SUSPENDED' || (patch.role && patch.role !== 'ADMIN'))
      ) {
        const others = await db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND id <> ?",
          [existing.id],
        );
        if (Number(others?.n ?? 0) === 0) {
          throw ApiError.conflict('This is the last active administrator and cannot be disabled.');
        }
      }

      if (patch.password) {
        const problems = passwordProblems(patch.password);
        if (problems.length > 0) {
          throw ApiError.validation(
            'That password does not meet the minimum policy.',
            problems.map((message) => ({ path: 'password', message })),
          );
        }
      }

      await db.run(
        'UPDATE users SET name = ?, phone = ?, role = ?, chw_identifier = ?, village = ?, status = ?,' +
          ' password_hash = COALESCE(?, password_hash), updated_at = ? WHERE id = ?',
        [
          patch.name ?? existing.name,
          patch.phone !== undefined ? patch.phone : existing.phone,
          patch.role ?? existing.role,
          patch.chwIdentifier !== undefined ? patch.chwIdentifier : existing.chwIdentifier,
          patch.village !== undefined ? patch.village : existing.village,
          patch.status ?? existing.status,
          patch.password ? await hashPassword(patch.password) : null,
          new Date().toISOString(),
          existing.id,
        ],
      );

      await recordAuditSafely(db, {
        userId: actor.id,
        action: AUDIT_ACTIONS.USER_UPDATE,
        entityType: 'user',
        entityId: existing.id,
        metadata: {
          role: patch.role ?? existing.role,
          status: patch.status ?? existing.status,
          passwordChanged: Boolean(patch.password),
        },
        ipAddress: req.ip ?? null,
      });

      const updated = await db.get('SELECT * FROM users WHERE id = ?', [existing.id]);
      res.json({ data: updated ? mapUser(updated) : null });
    }),
  );

  return router;
}

export function auditRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    requireAnyPermission('audit:read'),
    asyncRoute(async (req, res) => {
      const actor = authed(req);
      const q = z
        .object({
          action: z.string().trim().max(64).optional(),
          userId: z.string().uuid().optional(),
          entityType: z.string().trim().max(64).optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);

      const where: string[] = ['1 = 1'];
      const params: Param[] = [];

      if (q.action) {
        where.push('a.action = ?');
        params.push(q.action);
      }
      if (q.userId) {
        where.push('a.user_id = ?');
        params.push(q.userId);
      }
      if (q.entityType) {
        where.push('a.entity_type = ?');
        params.push(q.entityType);
      }
      if (q.from) {
        where.push('a.timestamp >= ?');
        params.push(q.from);
      }
      if (q.to) {
        where.push('a.timestamp <= ?');
        params.push(q.to);
      }

      const clause = where.join(' AND ');
      const offset = (q.page - 1) * q.pageSize;

      const [rows, total] = await Promise.all([
        db.all<Record<string, unknown>>(
          'SELECT a.*, u.name AS user_name, u.role AS user_role FROM audit_logs a' +
            ' LEFT JOIN users u ON u.id = a.user_id' +
            ` WHERE ${clause} ORDER BY a.timestamp DESC LIMIT ? OFFSET ?`,
          [...params, q.pageSize, offset],
        ),
        db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs a WHERE ${clause}`, params),
      ]);

      // Reading the audit log is itself a sensitive operation, so it is audited.
      await recordAuditSafely(db, {
        userId: actor.id,
        action: AUDIT_ACTIONS.AUDIT_VIEW,
        entityType: 'audit',
        metadata: { rows: rows.length },
        ipAddress: req.ip ?? null,
      });

      res.json({
        data: rows.map((r) => ({
          id: r.id,
          userId: r.user_id ?? null,
          userName: r.user_name ?? null,
          userRole: r.user_role ?? null,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id ?? null,
          timestamp: r.timestamp,
          metadata: r.metadata ? JSON.parse(String(r.metadata)) : null,
          ipAddress: r.ip_address ?? null,
        })),
        pagination: {
          page: q.page,
          pageSize: q.pageSize,
          total: Number(total?.n ?? 0),
          totalPages: Math.ceil(Number(total?.n ?? 0) / q.pageSize),
        },
      });
    }),
  );

  return router;
}

/** Village list, used to populate filters in both clients. */
export function referenceRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/villages',
    asyncRoute(async (_req, res) => {
      const rows = await db.all<{ village: string }>(
        'SELECT DISTINCT village FROM patients ORDER BY village',
      );
      res.json({ data: rows.map((r) => r.village) });
    }),
  );

  router.get(
    '/facilities',
    asyncRoute(async (_req, res) => {
      // Referral destinations are free text in the MVP; the distinct values already in
      // use are offered as suggestions so spelling stays consistent across CHWs.
      const rows = await db.all<{ destination: string }>(
        'SELECT DISTINCT destination FROM referrals ORDER BY destination',
      );
      res.json({ data: rows.map((r) => r.destination) });
    }),
  );

  return router;
}

export const _fromBool = fromBool;
