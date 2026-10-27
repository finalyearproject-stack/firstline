/**
 * Patient and visit routes.
 *
 * Access is scoped by role at the query level, not by filtering after the fact: a CHW's
 * list query carries `created_by = <their id>` in the WHERE clause, so there is no code
 * path on which another CHW's patients are loaded and then hidden.
 */
import { Router } from 'express';
import { patientSchema, referralSchema, symptomSchema, triageSchema, visitSchema, uuid } from '@rhm/shared';
import { z } from 'zod';
import type { Db, Param } from '../db/index.ts';
import { authed, requireAuth, requireAnyPermission } from '../auth/middleware.ts';
import { ApiError, asyncRoute } from '../middleware/errors.ts';
import { AUDIT_ACTIONS, recordAuditSafely } from '../services/audit.ts';
import {
  findPatient,
  loadVisitBundle,
  mapPatient,
  mapVisit,
  upsertPatient,
  upsertReferral,
  upsertSymptom,
  upsertTriage,
  upsertVisit,
  upsertVitals,
} from '../services/repositories.ts';
import { vitalsSchema } from '@rhm/shared';

const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  village: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function patientRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  // -------------------------------------------------------------------------
  // GET /patients
  // -------------------------------------------------------------------------
  router.get(
    '/',
    requireAnyPermission('patient:read:own', 'patient:read:all'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const { search, village, page, pageSize } = listQuerySchema.parse(req.query);

      const where: string[] = ['1 = 1'];
      const params: Param[] = [];

      // A CHW sees only the patients they registered. Enforced in SQL.
      if (user.role === 'CHW') {
        where.push('created_by = ?');
        params.push(user.id);
      }

      if (village) {
        where.push('village = ?');
        params.push(village);
      }

      if (search) {
        where.push('(LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ? OR LOWER(local_id) LIKE ?)');
        const like = `%${search.toLowerCase()}%`;
        params.push(like, like, like);
      }

      const clause = where.join(' AND ');
      const offset = (page - 1) * pageSize;

      const [rows, total] = await Promise.all([
        db.all(
          `SELECT * FROM patients WHERE ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
          [...params, pageSize, offset],
        ),
        db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM patients WHERE ${clause}`, params),
      ]);

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.PATIENT_LIST,
        entityType: 'patient',
        metadata: { count: rows.length, village: village ?? null },
        ipAddress: req.ip ?? null,
      });

      res.json({
        data: rows.map(mapPatient),
        pagination: {
          page,
          pageSize,
          total: Number(total?.n ?? 0),
          totalPages: Math.ceil(Number(total?.n ?? 0) / pageSize),
        },
      });
    }),
  );

  // -------------------------------------------------------------------------
  // POST /patients
  // -------------------------------------------------------------------------
  router.post(
    '/',
    requireAnyPermission('patient:create'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const now = new Date().toISOString();

      const input = patientSchema.parse({
        ...req.body,
        id: req.body?.id ?? uuid(),
        createdBy: user.id,
        createdAt: req.body?.createdAt ?? now,
        updatedAt: now,
        version: req.body?.version ?? 1,
      });

      await upsertPatient(db, { ...input, serverId: input.id, syncStatus: 'SYNCED' });

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.PATIENT_CREATE,
        entityType: 'patient',
        entityId: input.id,
        metadata: { village: input.village, consentStatus: input.consentStatus },
        ipAddress: req.ip ?? null,
      });

      const stored = await findPatient(db, input.id);
      res.status(201).json({ data: stored });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /patients/:id
  // -------------------------------------------------------------------------
  router.get(
    '/:id',
    requireAnyPermission('patient:read:own', 'patient:read:all'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const patient = await assertPatientAccess(db, user, req.params.id);

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.PATIENT_VIEW,
        entityType: 'patient',
        entityId: patient.id,
        ipAddress: req.ip ?? null,
      });

      res.json({ data: patient });
    }),
  );

  // -------------------------------------------------------------------------
  // PUT /patients/:id
  // -------------------------------------------------------------------------
  router.put(
    '/:id',
    requireAnyPermission('patient:update'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const existing = await assertPatientAccess(db, user, req.params.id);

      const input = patientSchema.parse({
        ...existing,
        ...req.body,
        id: existing.id,
        createdBy: existing.createdBy,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
        // The server owns the version counter on this path, so two edits from the
        // dashboard cannot both claim to be version 2.
        version: existing.version + 1,
      });

      await upsertPatient(db, { ...input, serverId: input.id, syncStatus: 'SYNCED' });

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.PATIENT_UPDATE,
        entityType: 'patient',
        entityId: input.id,
        metadata: { version: input.version },
        ipAddress: req.ip ?? null,
      });

      res.json({ data: await findPatient(db, input.id) });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /patients/:id/visits  — full clinical history
  // -------------------------------------------------------------------------
  router.get(
    '/:id/visits',
    requireAnyPermission('visit:read:own', 'visit:read:all'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const patient = await assertPatientAccess(db, user, req.params.id);

      const visitRows = await db.all(
        'SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_date DESC',
        [patient.id],
      );

      const bundles = await Promise.all(
        visitRows.map(async (row) => {
          const visit = mapVisit(row);
          return { visit, ...(await loadVisitBundle(db, visit.id)) };
        }),
      );

      res.json({ data: { patient, visits: bundles } });
    }),
  );

  return router;
}

/**
 * Loads a patient and asserts the caller may see them.
 *
 * Returns 404 rather than 403 when a CHW asks for another CHW's patient: a 403 would
 * confirm that a patient with that id exists, which is itself information about a
 * person the caller has no relationship with.
 */
async function assertPatientAccess(
  db: Db,
  user: { id: string; role: string },
  id: string,
) {
  const patient = await findPatient(db, id);
  if (!patient) throw ApiError.notFound('Patient');
  if (user.role === 'CHW' && patient.createdBy !== user.id) {
    throw ApiError.notFound('Patient');
  }
  return patient;
}

// ---------------------------------------------------------------------------
// Visit routes (mounted separately at /visits)
// ---------------------------------------------------------------------------

export function visitRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  /**
   * POST /visits — records a complete screening encounter in one transaction.
   *
   * The whole encounter lands together or not at all. A visit stored without its
   * triage result would show a health official a screening that appears to have found
   * nothing, which is worse than showing nothing at all.
   */
  router.post(
    '/',
    requireAnyPermission('visit:create'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const now = new Date().toISOString();

      const body = z
        .object({
          visit: z.unknown(),
          vitals: z.unknown().optional(),
          symptoms: z.array(z.unknown()).optional(),
          triage: z.unknown().optional(),
          referral: z.unknown().optional(),
        })
        .parse(req.body);

      const visit = visitSchema.parse({
        ...(body.visit as object),
        id: (body.visit as { id?: string })?.id ?? uuid(),
        chwId: user.id,
        createdAt: (body.visit as { createdAt?: string })?.createdAt ?? now,
        updatedAt: now,
        version: 1,
      });

      const patient = await findPatient(db, visit.patientId);
      if (!patient) throw ApiError.notFound('Patient');
      if (user.role === 'CHW' && patient.createdBy !== user.id) throw ApiError.notFound('Patient');

      await db.transaction(async (tx) => {
        await upsertVisit(tx, { ...visit, syncStatus: 'SYNCED' });

        if (body.vitals) {
          const vitals = vitalsSchema.parse({
            ...(body.vitals as object),
            id: (body.vitals as { id?: string })?.id ?? uuid(),
            visitId: visit.id,
            recordedAt: (body.vitals as { recordedAt?: string })?.recordedAt ?? now,
          });
          await upsertVitals(tx, { ...vitals, syncStatus: 'SYNCED' });
        }

        for (const raw of body.symptoms ?? []) {
          const symptom = symptomSchema.parse({
            ...(raw as object),
            id: (raw as { id?: string })?.id ?? uuid(),
            visitId: visit.id,
          });
          await upsertSymptom(tx, { ...symptom, syncStatus: 'SYNCED' });
        }

        if (body.triage) {
          const triage = triageSchema.parse({
            ...(body.triage as object),
            id: (body.triage as { id?: string })?.id ?? uuid(),
            visitId: visit.id,
            createdAt: (body.triage as { createdAt?: string })?.createdAt ?? now,
          });
          await upsertTriage(tx, { ...triage, syncStatus: 'SYNCED' });
        }

        if (body.referral) {
          const referral = referralSchema.parse({
            ...(body.referral as object),
            id: (body.referral as { id?: string })?.id ?? uuid(),
            visitId: visit.id,
            patientId: visit.patientId,
            createdBy: user.id,
            createdAt: (body.referral as { createdAt?: string })?.createdAt ?? now,
            version: 1,
          });
          await upsertReferral(tx, { ...referral, syncStatus: 'SYNCED' });
        }
      });

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.VISIT_CREATE,
        entityType: 'visit',
        entityId: visit.id,
        metadata: { village: visit.village },
        ipAddress: req.ip ?? null,
      });

      res.status(201).json({ data: { visit, ...(await loadVisitBundle(db, visit.id)) } });
    }),
  );

  router.get(
    '/:id',
    requireAnyPermission('visit:read:own', 'visit:read:all'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const row = await db.get('SELECT * FROM visits WHERE id = ?', [req.params.id]);
      if (!row) throw ApiError.notFound('Visit');

      const visit = mapVisit(row);
      if (user.role === 'CHW' && visit.chwId !== user.id) throw ApiError.notFound('Visit');

      res.json({ data: { visit, ...(await loadVisitBundle(db, visit.id)) } });
    }),
  );

  return router;
}
