/**
 * Migration runner.
 *
 * Migrations are plain .sql files applied in filename order and recorded in
 * `schema_migrations`. Each file is applied exactly once. The production schema is
 * never edited by hand (spec s22); every change is a new numbered file.
 *
 * The {{TOKEN}} substitution below is what lets one .sql file serve both dialects.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createDb, type Db, type Dialect } from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

const TYPE_MAP: Record<Dialect, Record<string, string>> = {
  sqlite: {
    PK: 'TEXT',
    TEXT: 'TEXT',
    INT: 'INTEGER',
    REAL: 'REAL',
    BOOL: 'INTEGER',
    TS: 'TEXT',
    JSON: 'TEXT',
  },
  postgres: {
    PK: 'UUID',
    TEXT: 'TEXT',
    INT: 'INTEGER',
    REAL: 'DOUBLE PRECISION',
    BOOL: 'BOOLEAN',
    TS: 'TEXT',
    JSON: 'JSONB',
  },
};

export function render(sql: string, dialect: Dialect): string {
  const map = TYPE_MAP[dialect];

  // Substitute only in real SQL. Comment lines are left untouched so that the schema
  // file can document its own token vocabulary without the runner trying to expand it.
  let out = sql
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('--')) return line;
      return line.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
        const replacement = map[token];
        if (!replacement) throw new Error(`Unknown schema type token ${match}`);
        return replacement;
      });
    })
    .join('\n');

  if (dialect === 'postgres') {
    // BOOLEAN columns are declared with numeric defaults in the canonical file so the
    // SQLite rendering stays valid; fix them up for PostgreSQL.
    out = out.replace(/BOOLEAN NOT NULL DEFAULT 1/g, 'BOOLEAN NOT NULL DEFAULT TRUE');
    out = out.replace(/BOOLEAN NOT NULL DEFAULT 0/g, 'BOOLEAN NOT NULL DEFAULT FALSE');
  }

  return out;
}

/**
 * Splits a script into individual statements.
 *
 * Single pass, because the two hazards interact: a `--` comment may contain a
 * semicolon (which must not end a statement) and a string literal may contain a `--`
 * (which must not start a comment). Stripping comments and splitting separately gets
 * one of the two cases wrong whichever order you choose.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];

    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }

    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }

    // Line comment: discard through to the newline, keeping the newline itself so
    // the remaining SQL stays readable in error messages.
    if (ch === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i);
      if (newline === -1) break;
      i = newline;
      current += '\n';
      continue;
    }

    if (ch === ';') {
      statements.push(current);
      current = '';
      continue;
    }

    current += ch;
  }
  statements.push(current);

  return statements.map((s) => s.trim()).filter(Boolean);
}

export async function migrate(db: Db, log: (msg: string) => void = console.log): Promise<string[]> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      '  name TEXT PRIMARY KEY,' +
      '  applied_at TEXT NOT NULL' +
      ')',
  );

  const applied = new Set(
    (await db.all<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const run: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const sql = render(raw, db.dialect);

    // Each migration is one transaction: a half-applied schema change is worse than
    // no schema change at all.
    await db.transaction(async (tx) => {
      for (const statement of splitStatements(sql)) {
        await tx.exec(statement);
      }
      await tx.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [
        file,
        new Date().toISOString(),
      ]);
    });

    run.push(file);
    log(`  applied ${file}`);
  }

  if (run.length === 0) log('  schema already up to date');
  return run;
}

/** True when this module is the process entry point, on POSIX and Windows alike. */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(moduleUrl) === resolve(entry);
  } catch {
    return false;
  }
}

// Run directly: `npm run migrate`
if (isEntryPoint(import.meta.url)) {
  const db = await createDb();
  console.log(`Migrating (${db.dialect})...`);
  await migrate(db);
  await db.close();
  console.log('Done.');
}
