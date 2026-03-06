import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(fileURLToPath(new URL('..', import.meta.url)), 'migrations');

const files = await readdir(dir);
const upMigrations = files.filter((f) => /^\d+_.+\.sql$/.test(f) && !f.endsWith('.down.sql')).sort();

if (upMigrations.length === 0) {
  throw new Error('No migration files found.');
}

for (const file of upMigrations) {
  const base = file.replace('.sql', '');
  const down = `${base}.down.sql`;
  const md = `${base}.md`;

  if (!files.includes(down)) {
    throw new Error(`Missing down migration companion: ${down}`);
  }
  if (!files.includes(md)) {
    throw new Error(`Missing migration policy note: ${md}`);
  }

  const note = await readFile(join(dir, md), 'utf8');
  if (!note.includes('Not safe for production rollback')) {
    throw new Error(`Migration note ${md} must include forward-only production rollback warning.`);
  }
}

console.log(`Migration policy check passed for ${upMigrations.length} migration(s).`);
