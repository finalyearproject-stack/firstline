/**
 * Synchronisation and dashboard routes.
 */
import { Router } from 'express';
import { z } from 'zod';
import { syncRequestSchema } from '@rhm/shared';
import { config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { authed, requireAuth, requireAnyPermission } from '../auth/middleware.ts';
import { ApiError, asyncRoute } from '../middleware/errors.ts';
import { AUDIT_ACTIONS, recordAuditSafely } from '../services/audit.ts';
import { processSyncBatch } from '../services/sync.ts';
import {
  defaultRange,
  getAlerts,
  getChwActivity,
  getOverview,
  getReferralStats,
  getRiskByCategory,
  getScreeningsByFocus,
  getSymptomTrends,
  getScreeningVolume,
  getSyncHealth,
  getTriageTrend,
  getVillageStats,
} from '../services/dashboard.ts';

export function syncRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  /**
   * POST /sync — push a batch of locally captured records.
   *
   * Always returns 200 with a per-item result array, even when some items failed.
   * A blanket non-2xx would tell the client "the batch failed" and invite it to retry
   * records the server has already stored; the per-item verdict is what lets the client
   * clear exactly the entries that are safely persisted and keep the rest queued.
   */
  router.post(
    '/',
    requireAnyPermission('sync:push'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const request = syncRequestSchema.parse(req.body);

      if (request.items.length > config.sync.maxBatchSize) {
        throw new ApiError(
          'PAYLOAD_TOO_LARGE',
          `A sync batch may contain at most ${config.sync.maxBatchSize} records.`,
        );
      }

      const started = Date.now();
      const outcome = await processSyncBatch(db, user, request.items);

      await recordAuditSafely(db, {
        userId: user.id,
        action: AUDIT_ACTIONS.SYNC_PUSH,
        entityType: 'sync',
        metadata: {
          items: request.items.length,
          applied: outcome.applied,
          duplicates: outcome.duplicates,
          conflicts: outcome.conflicts,
          rejected: outcome.rejected,
          durationMs: Date.now() - started,
        },
        ipAddress: req.ip ?? null,
      });

      res.json({
        data: {
          results: outcome.results,
          summary: {
            received: request.items.length,
            applied: outcome.applied,
            duplicates: outcome.duplicates,
            conflicts: outcome.conflicts,
            rejected: outcome.rejected,
            durationMs: Date.now() - started,
          },
          serverTime: new Date().toISOString(),
        },
      });
    }),
  );

  /** GET /sync/status — what the server holds for this user, for reconciliation. */
  router.get(
    '/status',
    requireAnyPermission('sync:push'),
    asyncRoute(async (req, res) => {
      const user = authed(req);
      const [receipts, latest] = await Promise.all([
        db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_receipts WHERE user_id = ?', [user.id]),
        db.get<{ received_at: string }>(
          'SELECT MAX(received_at) AS received_at FROM sync_receipts WHERE user_id = ?',
          [user.id],
        ),
      ]);

      res.json({
        data: {
          recordsReceived: Number(receipts?.n ?? 0),
          lastSyncAt: latest?.received_at ?? null,
          serverTime: new Date().toISOString(),
        },
      });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const rangeSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  village: z.string().trim().max(120).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
});

function resolveRange(query: unknown) {
  const q = rangeSchema.parse(query);
  const base = defaultRange(q.days ?? 30);
  return {
    from: q.from ?? base.from,
    to: q.to ?? base.to,
    village: q.village ?? null,
  };
}

export function dashboardRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  // Every route below is aggregate-only, so `dashboard:aggregate` is the right gate:
  // district officials hold it, and none of these queries can return a patient identity.
  router.use(requireAnyPermission('dashboard:aggregate'));

  router.get(
    '/overview',
    asyncRoute(async (req, res) => {
      res.json({ data: await getOverview(db, resolveRange(req.query)) });
    }),
  );

  router.get(
    '/triage',
    asyncRoute(async (req, res) => {
      const range = resolveRange(req.query);
      const [trend, byCategory, byFocus] = await Promise.all([
        getTriageTrend(db, range),
        getRiskByCategory(db, range),
        getScreeningsByFocus(db, range),
      ]);
      res.json({ data: { trend, byCategory, byFocus } });
    }),
  );

  router.get(
    '/villages',
    asyncRoute(async (req, res) => {
      res.json({ data: await getVillageStats(db, resolveRange(req.query)) });
    }),
  );

  router.get(
    '/chws',
    asyncRoute(async (req, res) => {
      res.json({ data: await getChwActivity(db, resolveRange(req.query)) });
    }),
  );

  router.get(
    '/referrals',
    asyncRoute(async (req, res) => {
      res.json({ data: await getReferralStats(db, resolveRange(req.query)) });
    }),
  );

  router.get(
    '/screening-volume',
    asyncRoute(async (req, res) => {
      res.json({ data: await getScreeningVolume(db, resolveRange(req.query)) });
    }),
  );

  router.get(
    '/symptom-trends',
    asyncRoute(async (req, res) => {
      res.json({ data: await getSymptomTrends(db, resolveRange(req.query)) });
    }),
  );

  router.get(
    '/alerts',
    asyncRoute(async (_req, res) => {
      res.json({ data: await getAlerts(db) });
    }),
  );

  router.get(
    '/sync-health',
    asyncRoute(async (_req, res) => {
      res.json({ data: await getSyncHealth(db) });
    }),
  );

  return router;
}
