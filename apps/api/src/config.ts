/**
 * Runtime configuration.
 *
 * Every secret is read from the environment. Nothing sensitive is committed to source
 * (spec s17). In production the process refuses to start if a required secret is
 * missing, rather than silently falling back to a well-known default — a fallback
 * secret in a health system is a backdoor with a changelog entry.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * The repository root, derived from this file's own location (apps/api/src/config.ts).
 * Relative paths in the environment resolve against it rather than against the current
 * working directory, so `npm run seed` behaves the same whether it is invoked from the
 * repository root or from inside the workspace.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function resolveFromRoot(path: string): string {
  if (path === ':memory:' || isAbsolute(path)) return path;
  return resolve(REPO_ROOT, path);
}

export type Dialect = 'sqlite' | 'postgres';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        'See .env.example and README.md (Environment variables).',
    );
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

/** True when no JWT_SECRET was supplied and a throwaway one was generated. */
let jwtSecretIsEphemeral = false;

function resolveJwtSecret(): string {
  if (isProduction) {
    const secret = required('JWT_SECRET');
    if (secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters in production.');
    }
    return secret;
  }
  const provided = process.env.JWT_SECRET;
  if (provided) return provided;

  // Development and test only: ephemeral per-process secret. Restarting the API
  // invalidates existing tokens, which is the correct behaviour for a throwaway key.
  jwtSecretIsEphemeral = true;
  return randomBytes(48).toString('hex');
}

export const config = {
  nodeEnv,
  isProduction,
  isTest,
  port: int('PORT', 4000),
  host: process.env.HOST ?? '0.0.0.0',

  db: {
    dialect: (process.env.DB_DIALECT ?? (isProduction ? 'postgres' : 'sqlite')) as Dialect,
    /** SQLite file path; ':memory:' is used by the test suite. */
    sqlitePath: resolveFromRoot(process.env.SQLITE_PATH ?? './data/rhm.db'),
    postgresUrl: process.env.DATABASE_URL ?? '',
  },

  auth: {
    jwtSecret: resolveJwtSecret(),
    get secretIsEphemeral(): boolean {
      return jwtSecretIsEphemeral;
    },
    /** Field tokens are long-lived so a CHW offline for days is not logged out. */
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL', 60 * 60 * 24 * 7),
    issuer: process.env.JWT_ISSUER ?? 'rhm-api',
    /** scrypt cost; lowered in tests so the suite is not dominated by key derivation. */
    scryptCost: isTest ? 2 ** 12 : 2 ** 15,
  },

  rateLimit: {
    /** Tight bucket for credential endpoints. */
    loginWindowMs: int('LOGIN_RATE_WINDOW_MS', 15 * 60 * 1000),
    loginMax: int('LOGIN_RATE_MAX', 10),
    /** Generous bucket for sync: a CHW returning from a week offline pushes a lot. */
    apiWindowMs: int('API_RATE_WINDOW_MS', 60 * 1000),
    apiMax: int('API_RATE_MAX', 600),
  },

  cors: {
    /** Comma-separated list of dashboard/app origins. */
    origins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  },

  sync: {
    maxBatchSize: int('SYNC_MAX_BATCH', 200),
  },

  clients: {
    /**
     * Single-host deployment: the API also serves the built VHT app at / and the
     * dashboard at /dashboard, so everything shares one HTTPS origin and needs no CORS.
     */
    serve: process.env.SERVE_CLIENTS === 'true',
    chwDir: resolveFromRoot('apps/chw/dist'),
    dashboardDir: resolveFromRoot('apps/dashboard/dist'),
  },

  /**
   * Seeds the FICTIONAL demonstration data on a database with no users, so a hosted demo
   * can be signed into straight after its first deploy. Never set on a real deployment.
   */
  seedDemo: process.env.SEED_DEMO === 'true',
} as const;

if (isProduction && config.db.dialect === 'postgres' && !config.db.postgresUrl) {
  throw new Error('DATABASE_URL is required when DB_DIALECT=postgres.');
}
