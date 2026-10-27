/**
 * Express application factory.
 *
 * Exported as a factory taking an explicit `Db` so the integration tests can build an
 * app over an in-memory database without starting a listener or touching a real file.
 */
import express, { type Express } from 'express';
import cors from 'cors';
import { config } from './config.ts';
import type { Db } from './db/index.ts';
import { errorHandler, notFoundHandler } from './middleware/errors.ts';
import { createRateLimiter } from './middleware/rateLimit.ts';
import { authRoutes } from './routes/auth.ts';
import { patientRoutes, visitRoutes } from './routes/patients.ts';
import { awarenessRoutes, referralRoutes, triageRoutes } from './routes/clinical.ts';
import { dashboardRoutes, syncRoutes } from './routes/sync.ts';
import { auditRoutes, referenceRoutes, userRoutes } from './routes/admin.ts';
import { serveClients } from './clients.ts';

export function createApp(db: Db): Express {
  const app = express();

  // Behind a reverse proxy in production, so req.ip reflects the client rather than
  // the proxy — the rate limiter and the audit log both depend on it being right.
  if (config.isProduction) app.set('trust proxy', 1);

  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    // A JSON API that is never framed and never sniffed.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (config.isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.use(
    cors({
      origin: config.cors.origins,
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );

  // A sync batch of 200 records with vitals and symptoms is comfortably inside 2 MB;
  // anything larger is a mistake or an attack, and is refused before it is parsed.
  app.use(express.json({ limit: '2mb' }));

  app.use(
    createRateLimiter({
      windowMs: config.rateLimit.apiWindowMs,
      max: config.rateLimit.apiMax,
    }),
  );

  // Liveness probe: no auth, no database access, no information disclosure.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Readiness probe: confirms the database is actually reachable.
  app.get('/ready', (_req, res) => {
    db.get('SELECT 1 AS ok')
      .then(() => res.json({ status: 'ready' }))
      .catch(() => res.status(503).json({ status: 'unavailable' }));
  });

  const v1 = express.Router();
  v1.use('/auth', authRoutes(db));
  v1.use('/patients', patientRoutes(db));
  v1.use('/visits', visitRoutes(db));
  v1.use('/triage', triageRoutes(db));
  v1.use('/referrals', referralRoutes(db));
  v1.use('/awareness', awarenessRoutes(db));
  v1.use('/sync', syncRoutes(db));
  v1.use('/dashboard', dashboardRoutes(db));
  v1.use('/users', userRoutes(db));
  v1.use('/audit', auditRoutes(db));
  v1.use('/reference', referenceRoutes(db));

  // Versioned from the first release, so a breaking change can ship as /api/v2 while
  // field devices that have not been updated in months keep working against /api/v1.
  app.use('/api/v1', v1);

  if (config.clients.serve) serveClients(app, config.clients);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
