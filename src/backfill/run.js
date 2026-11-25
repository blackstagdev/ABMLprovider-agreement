// Resumable historical signature backfill.
//  - dry_run (default): reads GHL + Shopify, writes ONLY backfill_runs/backfill_records + report files.
//  - apply: records verified signatures and writes Shopify (idempotent; safe to restart).
// Paging: fixed date windows from BACKFILL_START_DATE up to the run's frozen upper bound, each
// paged with limit/skip; the checkpoint is {windowIndex, skip}. Re-processing a page is a no-op
// because backfill_records is keyed by (run, document, recipient).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeEmail } from '../domain/identity.js';
import { log } from '../log.js';
import { repo } from '../sync/repo.js';

export const OUTCOMES = ['newly_signed', 'already_signed', 'missing', 'ambiguous', 'unresolved', 'not_signed', 'failed'];

export function buildWindows(startDate, upperBound, windowDays) {
  const out = [];
  let from = new Date(startDate);
  const end = new Date(upperBound);
  while (from < end) {
    const to = new Date(Math.min(end.getTime(), from.getTime() + windowDays * 86400_000));
    out.push({ dateFrom: from.toISOString(), dateTo: to.toISOString() });
    from = to;
  }
  return out;
}

export async function buildShopifyIndex(shopify) {
  const byGhlId = new Map();
  const byEmail = new Map();
  let total = 0;
  for await (const c of shopify.allCustomers()) {
    total++;
    if (c.ghlContactId) byGhlId.set(c.ghlContactId, [...(byGhlId.get(c.ghlContactId) ?? []), c]);
    const e = normalizeEmail(c.email);
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), c]);
  }
  return { byGhlId, byEmail, total };
}

async function startOrResume(db, { mode, locationId, resumeRunId, now }) {
  if (resumeRunId) {
    const r = (await db.query('SELECT * FROM backfill_runs WHERE id = $1', [resumeRunId])).rows[0];
    if (!r) throw new Error(`Backfill run ${resumeRunId} not found`);
    if (r.mode !== mode) throw new Error(`Run ${resumeRunId} is a ${r.mode} run`);
    return r;
  }
  const open = (await db.query(`SELECT * FROM backfill_runs WHERE status IN ('running','failed') AND mode = $1 AND location_id = $2 ORDER BY id DESC LIMIT 1`, [mode, locationId])).rows[0];
  if (open) return open;
  return (
    await db.query(`INSERT INTO backfill_runs (mode, location_id, upper_bound) VALUES ($1,$2,$3) RETURNING *`, [mode, locationId, now.toISOString()])
  ).rows[0];
}

export async function runBackfill({ db, ghl, shopify, sync, cfg, mode = 'dry_run', resumeRunId = null, reportDir = 'reports', now = new Date(), onProgress = () => {} }) {
  if (!['dry_run', 'apply'].includes(mode)) throw new Error('mode must be dry_run or apply');
  const run = await startOrResume(db, { mode, locationId: cfg.ghl.locationId, resumeRunId, now });
  await db.query(`UPDATE backfill_runs SET status = 'running', last_error = NULL, updated_at = now() WHERE id = $1`, [run.id]);
  log.info('backfill start', { runId: run.id, mode, checkpoint: run.checkpoint });

  const index = await buildShopifyIndex(shopify);
  const windows = buildWindows(cfg.backfill.startDate, run.upper_bound, cfg.backfill.windowDays);
  let { windowIndex = 0, skip = 0 } = run.checkpoint ?? {};

  const record = async (documentId, recipientId, outcome, extra = {}) => {
    await db.query(
      `INSERT INTO backfill_records (run_id, document_id, recipient_id, outcome, ghl_contact_id, shopify_customer_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [run.id, documentId ?? 'unknown', recipientId ?? '-', outcome, extra.contactId ?? null, extra.customerId ?? null, JSON.stringify(extra.detail ?? {})],
    );
  };
  const seen = async (documentId, recipientId) =>
    (await db.query('SELECT 1 FROM backfill_records WHERE run_id=$1 AND document_id=$2 AND recipient_id=$3', [run.id, documentId, recipientId])).rows.length > 0;

  try {
    for (; windowIndex < windows.length; windowIndex++, skip = 0) {
      for await (const page of ghl.pages({ ...windows[windowIndex], pageSize: cfg.backfill.pageSize, startSkip: skip })) {
        for (const ev of await sync.evaluateDocs(db, page.documents)) {
          if (ev.classification.kind === 'not_agreement') continue;
          if (ev.problem) {
            await record(ev.documentId, '-', 'unresolved', { detail: { reason: ev.problem } });
            continue;
          }
          for (const s of ev.signers) {
            if (await seen(ev.documentId, s.recipientId)) continue;
            await processSigner({ s, ev, mode, db, sync, index, record });
          }
        }
        skip = page.skip + page.documents.length;
        await db.query(`UPDATE backfill_runs SET checkpoint = $2, updated_at = now() WHERE id = $1`, [run.id, JSON.stringify({ windowIndex, skip })]);
        onProgress({ windowIndex, windows: windows.length, skip });
      }
    }
  } catch (err) {
    await db.query(`UPDATE backfill_runs SET status = 'failed', last_error = $2, checkpoint = $3, updated_at = now() WHERE id = $1`, [run.id, String(err.message).slice(0, 500), JSON.stringify({ windowIndex, skip })]);
    log.error('backfill failed; rerun the same command to resume', { runId: run.id, err });
    throw err;
  }

  const summary = await summarize(db, run.id);
  await db.query(`UPDATE backfill_runs SET status = 'completed', counts = $2, finished_at = now(), updated_at = now(), checkpoint = $3 WHERE id = $1`, [run.id, JSON.stringify(summary), JSON.stringify({ windowIndex, skip: 0 })]);
  const files = await writeReports(db, run, summary, index.total, reportDir);
  log.info('backfill complete', { runId: run.id, mode, summary });
  return { runId: run.id, mode, summary, files };
}

async function processSigner({ s, ev, mode, db, sync, index, record }) {
  const base = { contactId: s.contactId };
  if (s.outcome === 'unresolved') return record(ev.documentId, s.recipientId, 'unresolved', { ...base, detail: { reason: s.reason, signerCompleted: !!s.wouldBeSigned } });
  if (s.outcome === 'not_signed') return record(ev.documentId, s.recipientId, 'not_signed', { ...base, detail: { reason: s.reason } });
  try {
    const m = await sync.matchSigner(s, index);
    if (mode === 'apply') await repo.recordSignature(db, s); // also lets a later-created customer pick it up
    if (m.status !== 'matched') return record(ev.documentId, s.recipientId, m.status, { ...base, detail: { reason: m.reason } });
    const customerId = m.customer.id;
    const detail = { method: m.method, via: s.via };
    if (m.customer.signed === true && mode === 'dry_run') return record(ev.documentId, s.recipientId, 'already_signed', { ...base, customerId, detail });
    if (mode === 'dry_run') return record(ev.documentId, s.recipientId, 'newly_signed', { ...base, customerId, detail: { ...detail, dryRun: true } });
    const outcome = await sync.applySigned(customerId, s.contactId, { force: true });
    return record(ev.documentId, s.recipientId, outcome, { ...base, customerId, detail });
  } catch (err) {
    return record(ev.documentId, s.recipientId, 'failed', { ...base, detail: { error: String(err.message).slice(0, 300) } });
  }
}

export async function summarize(db, runId) {
  const byRecord = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const r of (await db.query('SELECT outcome, count(*)::int AS n FROM backfill_records WHERE run_id=$1 GROUP BY outcome', [runId])).rows) byRecord[r.outcome] = r.n;
  // Per-contact view: a contact's best outcome wins, so an older/duplicate unsigned invitation
  // never hides a verified signature.
  const rank = `CASE outcome WHEN 'newly_signed' THEN 1 WHEN 'already_signed' THEN 2 WHEN 'ambiguous' THEN 3 WHEN 'missing' THEN 4 WHEN 'failed' THEN 5 WHEN 'unresolved' THEN 6 ELSE 7 END`;
  const byContact = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const rows = (
    await db.query(
      `SELECT outcome, count(*)::int AS n FROM (
         SELECT DISTINCT ON (coalesce(ghl_contact_id, document_id)) outcome FROM backfill_records WHERE run_id=$1
         ORDER BY coalesce(ghl_contact_id, document_id), ${rank}) x GROUP BY outcome`,
      [runId],
    )
  ).rows;
  for (const r of rows) byContact[r.outcome] = r.n;
  const matched = byContact.newly_signed + byContact.already_signed;
  return { matched, byContact, byRecord };
}

async function writeReports(db, run, summary, shopifyCustomers, reportDir) {
  await mkdir(reportDir, { recursive: true });
  const rows = (await db.query('SELECT * FROM backfill_records WHERE run_id=$1 ORDER BY outcome, document_id', [run.id])).rows;
  const base = path.join(reportDir, `backfill-${run.id}-${run.mode}`);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['outcome,document_id,recipient_id,ghl_contact_id,shopify_customer_id,reason,method']
    .concat(rows.map((r) => [r.outcome, r.document_id, r.recipient_id, r.ghl_contact_id, r.shopify_customer_id, r.detail?.reason ?? r.detail?.error, r.detail?.method].map(esc).join(',')))
    .join('\n');
  const review = ['document_id,decision,note,reason,signer_completed']
    .concat(rows.filter((r) => r.outcome === 'unresolved').map((r) => [r.document_id, '', '', r.detail?.reason, r.detail?.signerCompleted].map(esc).join(',')))
    .join('\n');
  await writeFile(`${base}.json`, JSON.stringify({ runId: run.id, mode: run.mode, locationId: run.location_id, upperBound: run.upper_bound, shopifyCustomersIndexed: shopifyCustomers, summary }, null, 2));
  await writeFile(`${base}.csv`, csv + '\n');
  await writeFile(`${base}-unresolved-review.csv`, review + '\n');
  return [`${base}.json`, `${base}.csv`, `${base}-unresolved-review.csv`];
}
