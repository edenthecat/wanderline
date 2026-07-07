import { Pool } from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { runner as migrationRunner } from 'node-pg-migrate';
import { logger } from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Find the migrations dir.
 *
 * Layout:
 *   - Dev (tsx):  this file is at backend/src/db/init.ts          → ../../migrations = backend/migrations
 *   - Prod image: this file is at /app/backend/dist/db/init.js    → ../../migrations = /app/backend/migrations
 *
 * Both resolve to backend/migrations relative to __dirname. Override with
 * MIGRATIONS_DIR env var if needed.
 */
function resolveMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const candidates = [
    join(__dirname, '..', '..', 'migrations'), // backend/{src,dist}/db → backend/migrations
    join(__dirname, '..', 'migrations'), // safety net
    join(process.cwd(), 'backend', 'migrations'), // ts-node from repo root
    join(process.cwd(), 'migrations'), // working dir == backend
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`Could not find migrations dir. Tried: ${candidates.join(', ')}`);
}

const MIGRATIONS_DIR = resolveMigrationsDir();

const MIGRATIONS_TABLE = 'pgmigrations';
const BASELINE_NAME = '1000000000000_baseline';

// Arbitrary advisory-lock key. Two backend instances starting concurrently
// will serialize through this lock so only one runs the bootstrap.
const BOOTSTRAP_ADVISORY_LOCK = 8675309001;

/**
 * Ensure the migrations tracking table exists, then mark the baseline as
 * applied if the schema is already present (i.e. an existing DB that pre-dates
 * the migration tooling). On a brand-new DB the migration runner will apply
 * the baseline normally.
 *
 * Safe to run concurrently: holds a session-scoped advisory lock and uses
 * ON CONFLICT DO NOTHING when inserting the baseline marker.
 */
async function bootstrapBaseline(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [BOOTSTRAP_ADVISORY_LOCK]);

    // Create the tracking table the same way node-pg-migrate would, plus a
    // unique index on name so duplicate-baseline inserts are no-ops.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        run_on TIMESTAMP NOT NULL
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${MIGRATIONS_TABLE}_name_uniq
      ON ${MIGRATIONS_TABLE} (name)
    `);

    // Has the baseline already been recorded?
    const tracked = await client.query(
      `SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE name = $1 LIMIT 1`,
      [BASELINE_NAME],
    );
    if (tracked.rows.length > 0) return;

    // Are core tables already present? (i.e. existing prod DB before this PR)
    const existing = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'projects' LIMIT 1
    `);

    if (existing.rows.length > 0) {
      const result = await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (name, run_on) VALUES ($1, NOW())
         ON CONFLICT (name) DO NOTHING`,
        [BASELINE_NAME],
      );
      if ((result.rowCount ?? 0) > 0) {
        logger.info('Baseline migration marked as applied for existing DB');
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [BOOTSTRAP_ADVISORY_LOCK]);
    } catch {
      /* releasing fails if connection is gone; ignore */
    }
    client.release();
  }
}

export async function initializeDatabase(pool: Pool): Promise<void> {
  try {
    await bootstrapBaseline(pool);

    const client = await pool.connect();
    try {
      // node-pg-migrate accepts a dbClient — use one from our pool so we
      // share the connection settings (Cloud SQL Unix socket, etc.)
      await migrationRunner({
        dbClient: client,
        dir: MIGRATIONS_DIR,
        migrationsTable: MIGRATIONS_TABLE,
        direction: 'up',
        count: Infinity,
        verbose: true,
      });
    } finally {
      client.release();
    }
    logger.info('Database migrations applied successfully');
  } catch (error) {
    logger.error({ err: error }, 'Failed to apply database migrations');
    throw error;
  }
}
