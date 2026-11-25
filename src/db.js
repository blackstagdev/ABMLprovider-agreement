// Thin database adapter: `query(text, params)` -> { rows } and `tx(fn)`.
// Production uses node-postgres; tests use PGlite (real Postgres in WASM) with the same SQL.

import pg from 'pg';

export function createPgDb(databaseUrl) {
  const ssl = /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl, max: 10 });
  return {
    query: (text, params) => pool.query(text, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (t, p) => client.query(t, p) });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function wrapPglite(pglite) {
  return {
    query: (text, params) => pglite.query(text, params),
    tx: (fn) => pglite.transaction((t) => fn({ query: (q, p) => t.query(q, p) })),
    exec: (sql) => pglite.exec(sql),
    close: () => pglite.close(),
  };
}

/** Stable 32-bit key for pg_advisory_xact_lock from a string. */
export function lockKey(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
