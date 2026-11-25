// Durable Postgres job queue with dedupe, retries with backoff, and crash recovery.
import { log } from '../log.js';

export function createJobs(db) {
  return {
    /** Enqueue unless an identical job (dedupe key) is already pending/running. */
    async enqueue(type, payload, dedupeKey = null, { delaySeconds = 0 } = {}) {
      const r = await db.query(
        `INSERT INTO sync_jobs (type, payload, dedupe_key, run_at)
         VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
         ON CONFLICT (dedupe_key) WHERE status IN ('pending','running') DO NOTHING
         RETURNING id`,
        [type, JSON.stringify(payload ?? {}), dedupeKey, String(delaySeconds)],
      );
      return r.rows[0]?.id ?? null;
    },

    async claim() {
      const r = await db.query(
        `UPDATE sync_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
         WHERE id = (SELECT id FROM sync_jobs WHERE status = 'pending' AND run_at <= now()
                     ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING *`,
      );
      return r.rows[0] ?? null;
    },

    async complete(id) {
      await db.query(`UPDATE sync_jobs SET status = 'done', locked_at = NULL, updated_at = now() WHERE id = $1`, [id]);
    },

    async fail(job, err) {
      const final = job.attempts >= job.max_attempts;
      const backoff = Math.min(3600, 15 * 2 ** (job.attempts - 1));
      await db.query(
        `UPDATE sync_jobs SET status = $2, locked_at = NULL, last_error = $3,
           run_at = now() + ($4 || ' seconds')::interval, updated_at = now() WHERE id = $1`,
        [job.id, final ? 'failed' : 'pending', String(err?.message ?? err).slice(0, 500), String(backoff)],
      );
      return final;
    },

    /** Release jobs left 'running' by a crashed/restarted instance. */
    async recoverStale(minutes = 10) {
      const r = await db.query(
        `UPDATE sync_jobs SET status = 'pending', locked_at = NULL, updated_at = now()
         WHERE status = 'running' AND locked_at < now() - ($1 || ' minutes')::interval RETURNING id`,
        [String(minutes)],
      );
      if (r.rows.length) log.warn('recovered stale jobs', { count: r.rows.length });
      return r.rows.length;
    },

    async stats() {
      const r = await db.query(`SELECT status, count(*)::int AS n FROM sync_jobs GROUP BY status`);
      return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
    },
  };
}

export async function runOneJob(jobs, handlers) {
  const job = await jobs.claim();
  if (!job) return false;
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    const result = await handler(job.payload);
    await jobs.complete(job.id);
    log.info('job done', { id: job.id, type: job.type, outcome: result?.outcome });
  } catch (err) {
    const final = await jobs.fail(job, err);
    log[final ? 'error' : 'warn']('job failed', { id: job.id, type: job.type, attempt: job.attempts, final, err });
  }
  return true;
}

export function startWorker(jobs, handlers, { idleMs = 2000 } = {}) {
  let stopped = false;
  (async () => {
    await jobs.recoverStale().catch(() => {});
    while (!stopped) {
      let worked = false;
      try {
        worked = await runOneJob(jobs, handlers);
      } catch (err) {
        log.error('worker loop error', { err });
      }
      if (!worked) await new Promise((r) => setTimeout(r, idleMs));
    }
  })();
  return () => {
    stopped = true;
  };
}
