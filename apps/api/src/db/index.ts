/**
 * Database adapter.
 *
 * One narrow interface over two dialects: `node:sqlite` (built into Node 24) for
 * development and the test suite, PostgreSQL for production. Application code writes
 * SQL with `?` placeholders and never learns which engine is underneath.
 *
 * Deliberately not an ORM. The query surface here is small, the schema is fixed, and
 * the analytics queries in services/dashboard.ts are clearer as SQL than as a query
 * builder's fluent chain.
 */
import { config, type Dialect } from '../config.ts';

export type { Dialect };

export type Row = Record<string, unknown>;
export type Param = string | number | null;

export interface Db {
  dialect: Dialect;
  /** Runs a SELECT and returns every row. */
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  /** Runs a SELECT and returns the first row, or null. */
  get<T = Row>(sql: string, params?: Param[]): Promise<T | null>;
  /** Runs an INSERT/UPDATE/DELETE. */
  run(sql: string, params?: Param[]): Promise<void>;
  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** Executes raw DDL. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** PostgreSQL uses $1, $2...; SQLite uses ?. Application SQL is written with ?. */
function toPgPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${(index += 1)}`);
}

// ---------------------------------------------------------------------------
// SQLite (node:sqlite, built in since Node 22.5)
// ---------------------------------------------------------------------------

async function createSqlite(path: string): Promise<Db> {
  const { DatabaseSync } = await import('node:sqlite');

  // Create the containing directory on first run, so a fresh checkout does not need a
  // manual mkdir before the first migration.
  if (path !== ':memory:') {
    const { mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
  }

  const handle = new DatabaseSync(path);

  // WAL keeps readers from blocking the writer, which matters once the dashboard is
  // querying analytics while CHWs are syncing.
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');

  const api: Db = {
    dialect: 'sqlite',

    async all<T>(sql: string, params: Param[] = []): Promise<T[]> {
      return handle.prepare(sql).all(...params) as T[];
    },

    async get<T>(sql: string, params: Param[] = []): Promise<T | null> {
      const row = handle.prepare(sql).get(...params);
      return (row as T) ?? null;
    },

    async run(sql: string, params: Param[] = []): Promise<void> {
      handle.prepare(sql).run(...params);
    },

    async exec(sql: string): Promise<void> {
      handle.exec(sql);
    },

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      handle.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(api);
        handle.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          handle.exec('ROLLBACK');
        } catch {
          // A rollback failure must not mask the original error.
        }
        throw error;
      }
    },

    async close(): Promise<void> {
      handle.close();
    },
  };

  return api;
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

async function createPostgres(url: string): Promise<Db> {
  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString: url,
    max: 20,
    idleTimeoutMillis: 30_000,
    // Managed PostgreSQL almost always terminates TLS with its own CA; operators who
    // need strict verification set PGSSLROOTCERT and PGSSLMODE=verify-full.
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  function wrap(runner: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }): Db {
    return {
      dialect: 'postgres',

      async all<T>(sql: string, params: Param[] = []): Promise<T[]> {
        const result = await runner.query(toPgPlaceholders(sql), params);
        return result.rows as T[];
      },

      async get<T>(sql: string, params: Param[] = []): Promise<T | null> {
        const result = await runner.query(toPgPlaceholders(sql), params);
        return (result.rows[0] as T) ?? null;
      },

      async run(sql: string, params: Param[] = []): Promise<void> {
        await runner.query(toPgPlaceholders(sql), params);
      },

      async exec(sql: string): Promise<void> {
        await runner.query(sql);
      },

      async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn(wrap(client));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Preserve the original error.
          }
          throw error;
        } finally {
          client.release();
        }
      },

      async close(): Promise<void> {
        await pool.end();
      },
    };
  }

  return wrap(pool);
}

// ---------------------------------------------------------------------------

export async function createDb(options?: { dialect?: Dialect; path?: string; url?: string }): Promise<Db> {
  const dialect = options?.dialect ?? config.db.dialect;

  if (dialect === 'postgres') {
    return createPostgres(options?.url ?? config.db.postgresUrl);
  }
  return createSqlite(options?.path ?? config.db.sqlitePath);
}

let singleton: Db | null = null;

export async function getDb(): Promise<Db> {
  singleton ??= await createDb();
  return singleton;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}

/**
 * Booleans are SMALLINT in SQLite and BOOLEAN in PostgreSQL. These two helpers are the
 * only places that difference is allowed to surface.
 */
export function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't';
}

export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
