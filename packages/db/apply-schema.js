import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const schemaSql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(schemaSql);
  console.log('Schema applied successfully');
} finally {
  await pool.end();
}
