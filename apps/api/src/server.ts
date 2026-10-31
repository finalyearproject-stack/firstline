/**
 * Process entry point.
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.ts';
import { createApp } from './app.ts';
import { getDb, closeDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { seed } from './db/seed.ts';
import { installShippedRuleSet } from './routes/clinical.ts';

async function main(): Promise<void> {
  if (config.db.dialect === 'sqlite' && config.db.sqlitePath !== ':memory:') {
    await mkdir(dirname(config.db.sqlitePath), { recursive: true });
  }

  const db = await getDb();

  // Migrations run at boot so a fresh deployment is usable without a manual step.
  // They are idempotent, so this is safe on every restart.
  console.log(`[db] ${db.dialect}`);
  await migrate(db, (msg) => console.log(`[db]${msg}`));

  if (config.seedDemo) {
    const users = await db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM users');
    if (Number(users?.n ?? 0) === 0) {
      console.log('[db] empty database and SEED_DEMO=true: seeding FICTIONAL demo data');
      await seed(db, (msg) => console.log(`[db]${msg}`));
    }
  }

  const installed = await installShippedRuleSet(db);
  if (installed) console.log(`[triage] unapproved deployment moved to shipped template ${installed}`);

  const app = createApp(db);
  const server = app.listen(config.port, config.host, () => {
    console.log(`[api] listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
    console.log(`[api] base path /api/v1`);
    if (!config.isProduction) {
      console.log(
        '[api] development mode — TLS is terminated upstream; JWT secret is ' +
          (config.auth.secretIsEphemeral
            ? 'ephemeral (restarting invalidates existing tokens)'
            : 'from JWT_SECRET'),
      );
    }
  });

  // Graceful shutdown: stop accepting connections, let in-flight sync batches finish,
  // then close the database. A CHW's upload should not be truncated by a deploy.
  const shutdown = (signal: string) => {
    console.log(`[api] ${signal} received, shutting down`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[api] forced exit after 10s grace period');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[api] failed to start:', error);
  process.exit(1);
});
