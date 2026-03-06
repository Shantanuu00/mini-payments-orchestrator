import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const direction = process.argv[2] === 'down' ? 'down' : 'up';
const pool = new Pool({ connectionString: databaseUrl });

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;
    EXCEPTION WHEN duplicate_column THEN null;
    END $$;
  `);
}

function sortMigrations(files) {
  return files
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
}

function checksumOf(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

async function runUp() {
  const files = sortMigrations(await readdir(migrationsDir));
  for (const file of files) {
    const id = file.replace('.sql', '');

    let sql = await readFile(join(migrationsDir, file), 'utf8');
    if (sql.includes('\\i ../schema.sql')) {
      sql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
    }
    const checksum = checksumOf(sql);

    const existing = await pool.query('SELECT checksum FROM schema_migrations WHERE id = $1', [id]);
    if (existing.rowCount) {
      if (existing.rows[0].checksum && existing.rows[0].checksum !== checksum) {
        throw new Error(`Migration checksum mismatch for ${id}. Refusing to continue.`);
      }
      continue;
    }

    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [id, checksum]);
      await pool.query('COMMIT');
      console.log(`Applied migration: ${id}`);
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
}

async function runDown() {
  if (process.env.ALLOW_DB_ROLLBACK !== 'true') {
    throw new Error('Rollback blocked. Set ALLOW_DB_ROLLBACK=true for controlled rollback operations.');
  }

  const latest = await pool.query('SELECT id FROM schema_migrations ORDER BY applied_at DESC LIMIT 1');
  if (!latest.rowCount) {
    console.log('No migrations to rollback');
    return;
  }

  const id = latest.rows[0].id;
  const downFile = join(migrationsDir, `${id}.down.sql`);
  const downSql = await readFile(downFile, 'utf8');

  await pool.query('BEGIN');
  try {
    await pool.query(downSql);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [id]);
    await pool.query('COMMIT');
    console.log(`Rolled back migration: ${id}`);
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

try {
  await ensureMigrationsTable();
  if (direction === 'down') {
    await runDown();
  } else {
    await runUp();
  }
} finally {
  await pool.end();
}
