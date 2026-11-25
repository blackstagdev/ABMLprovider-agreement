// Applies migrations/*.sql in order, once each. `npm run migrate`.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(db, execMulti) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  // schema_migrations is created by 001; guard for first run.
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const ran = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    await (execMulti ? execMulti(sql) : db.query(sql));
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
    ran.push(f);
  }
  return ran;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { createPgDb } = await import('./db.js');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const db = createPgDb(url);
  try {
    const ran = await migrate(db);
    console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date');
  } finally {
    await db.close();
  }
}
