/**
 * Triage, referral, awareness-content and rule-set routes.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  awarenessContentSchema,
  composeReferralSms,
  auditSmsBody,
  MUAC_COLOURS,
  RDT_RESULTS,
  referralSchema,
  uuid,
  type Referral,
} from '@rhm/shared';
import { DEFAULT_RULESET, runTriage, validateRuleSet, type RuleSet } from '@rhm/triage';
import { fromBool, parseJson, toBool, type Db, type Param } from '../db/index.ts';
import { authed, requireAuth, requireAnyPermission } from '../auth/middleware.ts';
import { ApiError, asyncRoute } from '../middleware/errors.ts';
import { AUDIT_ACTIONS, recordAuditSafely } from '../services/audit.ts';
import { findPatient, mapReferral } from '../services/repositories.ts';
import { locationClause, locationFilterSchema, placesOf } from '../services/locations.ts';

// ---------------------------------------------------------------------------
// Active rule set
// ---------------------------------------------------------------------------

/**
 * Loads the rule set an administrator has published, falling back to the one shipped
 * with the build. The fallback matters: a database that has never been seeded must
 * still triage correctly rather than failing open.
 */
export async function loadActiveRuleSet(db: Db): Promise<RuleSet> {
  const row = await db.get<{ definition: string }>(
    'SELECT definition FROM triage_rulesets WHERE active = ? ORDER BY created_at DESC',
    [fromBool(true)],
  );
  if (!row) return DEFAULT_RULESET;

  const parsed = parseJson<RuleSet | null>(row.definition, null);
  if (!parsed) return DEFAULT_RULESET;

  // A stored rule set that fails validation is not used. Mis-triaging a patient from a
  // corrupt configuration is worse than running the known-good shipped default.
  const errors = validateRuleSet(parsed);
  if (errors.length > 0) {
    console.error('[triage] stored rule set is invalid, falling back to the bundled set:', errors);
    return DEFAULT_RULESET;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

/**
 * Keeps an unapproved deployment on the newest shipped template.
 *
 * Run at boot. While no clinical authority has approved a rule set, the active one is
 * just the template that came with the build, and an older copy left in the database
 * would hide rules added since (this happened once: the dashboard showed a 23-rule
 * version after the template had grown). An APPROVED active rule set is never
 * replaced: once a health authority has signed off, only an administrator publishing a
 * new version changes what is in force.
 *
 * Returns the version installed, or null when nothing changed.
 */
export async function installShippedRuleSet(db: Db): Promise<string | null> {
  const active = await db.get<{ version: string; approved_by: string | null }>(
    'SELECT version, approved_by FROM triage_rulesets WHERE active = ? ORDER BY created_at DESC',
    [fromBool(true)],
  );
  if (active?.approved_by) return null;
  if (active?.version === DEFAULT_RULESET.rulesetVersion) return null;

  const shipped = await db.get('SELECT id FROM triage_rulesets WHERE version = ?', [DEFAULT_RULESET.rulesetVersion]);
  await db.transaction(async (tx) => {
    await tx.run('UPDATE triage_rulesets SET active = ?', [fromBool(false)]);
    if (shipped) {
      await tx.run('UPDATE triage_rulesets SET active = ? WHERE version = ?', [fromBool(true), DEFAULT_RULESET.rulesetVersion]);
    } else {
      await tx.run(
        'INSERT INTO triage_rulesets (id, version, definition, active, approved_by, approved_on, created_by, created_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [uuid(), DEFAULT_RULESET.rulesetVersion, JSON.stringify(DEFAULT_RULESET), fromBool(true), null, null, null, new Date().toISOString()],
      );
    }
  });
  return DEFAULT_RULESET.rulesetVersion;
}

const triageFactsSchema = z.object({
  age: z.number().int().min(0).max(130).nullable().optional(),
  sex: z.enum(['FEMALE', 'MALE', 'OTHER']).nullable().optional(),
  systolicBp: z.number().nullable().optional(),
  diastolicBp: z.number().nullable().optional(),
  temperatureC: z.number().nullable().optional(),
  weightKg: z.number().nullable().optional(),
  pulseBpm: z.number().nullable().optional(),
  oxygenSaturation: z.number().nullable().optional(),
  respiratoryRate: z.number().nullable().optional(),
  bloodGlucoseMmol: z.number().nullable().optional(),
  muacColour: z.enum(MUAC_COLOURS).nullable().optional(),
  malariaRdt: z.enum(RDT_RESULTS).nullable().optional(),
  oedema: z.boolean().nullable().optional(),
  pregnancyWeeks: z.number().int().min(4).max(44).nullable().optional(),
  symptoms: z
    .array(
      z.object({
        symptomCode: z.string().max(64),
        severity: z.enum(['MILD', 'MODERATE', 'SEVERE']).nullable().optional(),
        durationDays: z.number().int().min(0).max(3650).nullable().optional(),
      }),
    )
    .max(64)
    .optional(),
});

export function triageRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  /**
   * POST /triage — server-side evaluation.
   *
   * The CHW app does NOT call this to obtain a result; it runs the identical engine
   * locally and offline. This endpoint exists so the dashboard can re-evaluate an
   * encounter against the current rule set, and so the two implementations can be
   * shown to agree. Nothing clinical depends on it being reachable.
   */
  router.post(
    '/',
    requireAnyPermission('triage:run', 'dashboard:aggregate'),
    asyncRoute(async (req, res) => {
      const facts = triageFactsSchema.parse(req.body);
      const ruleSet = await loadActiveRuleSet(db);
      const outcome = runTriage(facts, ruleSet);

      res.json({
        data: {
          ...outcome,
          disclaimer: ruleSet.metadata.disclaimer,
        },
      });
    }),
  );

  /** GET /triage/ruleset — the active rules, for the CHW app to cache for offline use. */
  router.get(
    '/ruleset',
    asyncRoute(async (_req, res) => {
      const ruleSet = await loadActiveRuleSet(db);
      res.json({ data: ruleSet });
    }),
  );

  /** PUT /triage/ruleset — publish a new rule set (administrators only). */
  router.put(
    '/ruleset',
    requireAnyPermission('rules:manage'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const candidate = req.body as RuleSet;

      const errors = validateRuleSet(candidate);
      if (errors.length > 0) {
        throw ApiError.validation(
          'The rule set is not valid and was not published.',
          errors.map((message) => ({ path: 'ruleset', message })),
        );
      }

      const existing = await db.get('SELECT id FROM triage_rulesets WHERE version = ?', [
        candidate.rulesetVersion,
      ]);
      if (existing) {
        throw ApiError.conflict(
          `Rule set version ${candidate.rulesetVersion} already exists. Raise the version to publish a change.`,
        );
      }

      await db.transaction(async (tx) => {
        await tx.run('UPDATE triage_rulesets SET active = ?', [fromBool(false)]);
        await tx.run(
          'INSERT INTO triage_rulesets (id, version, definition, active, approved_by, approved_on, created_by, created_at)' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            uuid(),
            candidate.rulesetVersion,
            JSON.stringify(candidate),
            fromBool(true),
            candidate.metadata?.approvedBy ?? null,
            candidate.metadata?.approvedOn ?? null,
            user.id,
            new Date().toISOString(),
          ],
        );
      });

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.RULESET_PUBLISH,
        entityType: 'ruleset',
        entityId: candidate.rulesetVersion,
        metadata: { ruleCount: candidate.rules.length },
        ipAddress: req.ip ?? null,
      });

      res.status(201).json({ data: { version: candidate.rulesetVersion, active: true } });
    }),
  );

  /** GET /triage/rulesets — publication history. */
  router.get(
    '/rulesets',
    requireAnyPermission('rules:manage'),
    asyncRoute(async (_req, res) => {
      const rows = await db.all<Record<string, unknown>>(
        'SELECT id, version, active, approved_by, approved_on, created_at FROM triage_rulesets ORDER BY created_at DESC',
      );
      res.json({
        data: rows.map((r) => ({
          id: r.id,
          version: r.version,
          active: toBool(r.active),
          approvedBy: r.approved_by ?? null,
          approvedOn: r.approved_on ?? null,
          createdAt: r.created_at,
        })),
      });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

const referralListSchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['PENDING', 'ACKNOWLEDGED', 'COMPLETED', 'CANCELLED']).optional(),
  urgency: z.enum(['IMMEDIATE', 'WITHIN_24H', 'ROUTINE']).optional(),
  village: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function referralRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    requireAnyPermission('referral:read'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const q = referralListSchema.parse(req.query);

      const where: string[] = ['1 = 1'];
      const params: Param[] = [];

      if (user.role === 'CHW') {
        where.push('r.created_by = ?');
        params.push(user.id);
      }
      if (q.status) {
        where.push('r.status = ?');
        params.push(q.status);
      }
      if (q.urgency) {
        where.push('r.urgency = ?');
        params.push(q.urgency);
      }
      const place = locationClause('p.village', { ...locationFilterSchema.parse(req.query), village: q.village });
      where.push(...place.sql);
      params.push(...place.params);
      if (q.search) {
        where.push('(LOWER(p.first_name) LIKE ? OR LOWER(p.last_name) LIKE ?)');
        const like = `%${q.search.toLowerCase()}%`;
        params.push(like, like);
      }

      const clause = where.join(' AND ');
      const offset = (q.page - 1) * q.pageSize;

      const [rows, total] = await Promise.all([
        db.all<Record<string, unknown>>(
          'SELECT r.*, p.first_name, p.last_name, p.village, p.age, p.sex, t.risk_level' +
            ' FROM referrals r' +
            ' JOIN patients p ON p.id = r.patient_id' +
            ' LEFT JOIN triage_results t ON t.visit_id = r.visit_id' +
            ` WHERE ${clause}` +
            " ORDER BY CASE r.urgency WHEN 'IMMEDIATE' THEN 0 WHEN 'WITHIN_24H' THEN 1 ELSE 2 END," +
            ' r.created_at DESC LIMIT ? OFFSET ?',
          [...params, q.pageSize, offset],
        ),
        db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM referrals r JOIN patients p ON p.id = r.patient_id WHERE ${clause}`,
          params,
        ),
      ]);

      const places = await placesOf(db, rows.map((row) => String(row.village)));
      res.json({
        data: rows.map((row) => ({
          ...mapReferral(row),
          place: places.get(String(row.village)) ?? null,
          patient: {
            // A referral is inherently identifiable to the nurse acting on it; the
            // route is gated on `referral:read`, which district officials do not hold.
            firstName: row.first_name,
            lastName: row.last_name,
            village: row.village,
            age: Number(row.age),
            sex: row.sex,
          },
          riskLevel: row.risk_level ?? null,
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

  router.post(
    '/',
    requireAnyPermission('referral:create'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const now = new Date().toISOString();

      const input = referralSchema.parse({
        ...req.body,
        id: req.body?.id ?? uuid(),
        status: req.body?.status ?? 'PENDING',
        createdBy: user.id,
        createdAt: req.body?.createdAt ?? now,
        completedAt: req.body?.completedAt ?? null,
        version: 1,
      });

      const patient = await findPatient(db, input.patientId);
      if (!patient) throw ApiError.notFound('Patient');

      const { upsertReferral } = await import('../services/repositories.ts');
      await upsertReferral(db, { ...input, syncStatus: 'SYNCED' } as Referral);

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.REFERRAL_CREATE,
        entityType: 'referral',
        entityId: input.id,
        metadata: { urgency: input.urgency, village: patient.village },
        ipAddress: req.ip ?? null,
      });

      res.status(201).json({ data: input });
    }),
  );

  /** PATCH /referrals/:id — facility acknowledges or completes a referral. */
  router.patch(
    '/:id',
    requireAnyPermission('referral:update'),
    asyncRoute(async (req, res) => {
      const user = authed(req);

      const patch = z
        .object({
          status: z.enum(['PENDING', 'ACKNOWLEDGED', 'COMPLETED', 'CANCELLED']),
          notes: z.string().trim().max(2000).nullable().optional(),
          followUpDate: z.string().date().nullable().optional(),
        })
        .parse(req.body);

      const row = await db.get('SELECT * FROM referrals WHERE id = ?', [req.params.id]);
      if (!row) throw ApiError.notFound('Referral');

      const existing = mapReferral(row);
      const completedAt =
        patch.status === 'COMPLETED'
          ? (existing.completedAt ?? new Date().toISOString())
          : null;

      await db.run(
        'UPDATE referrals SET status = ?, notes = ?, follow_up_date = ?, completed_at = ?, version = version + 1 WHERE id = ?',
        [
          patch.status,
          patch.notes ?? existing.notes,
          patch.followUpDate ?? existing.followUpDate,
          completedAt,
          existing.id,
        ],
      );

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.REFERRAL_UPDATE,
        entityType: 'referral',
        entityId: existing.id,
        metadata: { from: existing.status, to: patch.status },
        ipAddress: req.ip ?? null,
      });

      const updated = await db.get('SELECT * FROM referrals WHERE id = ?', [existing.id]);
      res.json({ data: updated ? mapReferral(updated) : null });
    }),
  );

  /**
   * POST /referrals/:id/sms — returns a minimal-disclosure SMS body.
   *
   * The server composes and audits the text; it does not send it. Sending happens on
   * the CHW's handset through the device dialler, so no patient contact detail is
   * relayed through a third-party gateway.
   */
  router.post(
    '/:id/sms',
    requireAnyPermission('referral:create', 'referral:update'),
    asyncRoute(async (req, res) => {
      const row = await db.get('SELECT * FROM referrals WHERE id = ?', [req.params.id]);
      if (!row) throw ApiError.notFound('Referral');

      const referral = mapReferral(row);
      const patient = await findPatient(db, referral.patientId);
      if (!patient) throw ApiError.notFound('Patient');
      if (!patient.phone) throw ApiError.validation('This patient has no phone number on record.');

      const body = composeReferralSms({
        firstName: patient.firstName,
        facility: referral.destination,
        urgency: referral.urgency,
        referralCode: referral.id.slice(0, 8).toUpperCase(),
        appointmentDate: referral.followUpDate,
      });

      // Defence in depth: if a future template change ever leaked clinical wording,
      // this check fails the request rather than sending it.
      const leaks = auditSmsBody(body);
      if (leaks.length > 0) {
        console.error('[sms] blocked a message containing clinical terms:', leaks);
        throw new ApiError('INTERNAL', 'The referral message could not be prepared safely.');
      }

      res.json({ data: { phone: patient.phone, body } });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// Awareness content
// ---------------------------------------------------------------------------

export function awarenessRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    requireAnyPermission('awareness:read'),
    asyncRoute(async (req, res) => {
      const q = z
        .object({
          language: z.string().trim().max(12).optional(),
          category: z.string().trim().max(80).optional(),
          /** Administrators may list retired content; everyone else sees active only. */
          includeInactive: z.coerce.boolean().default(false),
        })
        .parse(req.query);

      const user = authed(req);
      const where: string[] = [];
      const params: Param[] = [];

      if (!q.includeInactive || user.role !== 'ADMIN') {
        where.push('active = ?');
        params.push(fromBool(true));
      }
      if (q.language) {
        where.push('language = ?');
        params.push(q.language);
      }
      if (q.category) {
        where.push('category = ?');
        params.push(q.category);
      }

      const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const rows = await db.all<Record<string, unknown>>(
        `SELECT * FROM awareness_content${clause} ORDER BY category, title`,
        params,
      );

      res.json({
        data: rows.map((r) => ({
          id: r.id,
          title: r.title,
          language: r.language,
          category: r.category,
          summary: r.summary,
          body: r.body,
          audioPath: r.audio_path ?? null,
          version: Number(r.version),
          active: toBool(r.active),
          updatedAt: r.updated_at,
        })),
      });
    }),
  );

  router.put(
    '/:id',
    requireAnyPermission('awareness:manage'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const input = awarenessContentSchema.parse({ ...req.body, id: req.params.id });

      await db.run(
        'INSERT INTO awareness_content (id, title, language, category, summary, body, audio_path, version, active, updated_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
          ' ON CONFLICT (id) DO UPDATE SET title = excluded.title, language = excluded.language,' +
          '  category = excluded.category, summary = excluded.summary, body = excluded.body,' +
          '  audio_path = excluded.audio_path, version = excluded.version,' +
          '  active = excluded.active, updated_at = excluded.updated_at',
        [
          input.id, input.title, input.language, input.category, input.summary, input.body,
          input.audioPath, input.version, fromBool(input.active), new Date().toISOString(),
        ],
      );

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.AWARENESS_UPDATE,
        entityType: 'awareness',
        entityId: input.id,
        metadata: { language: input.language, category: input.category, version: input.version },
        ipAddress: req.ip ?? null,
      });

      res.json({ data: input });
    }),
  );

  return router;
}
