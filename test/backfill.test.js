import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBackfill, buildWindows } from '../src/backfill/run.js';
import { parseCsv } from '../src/csv.js';
import { repo } from '../src/sync/repo.js';
import { gid, makeDoc, setup } from './helpers.js';

const SIGNED = { hasCompleted: true, signedDate: '2025-03-02T12:00:00Z' };

/** Synthetic history covering every report category. */
async function seed(ctx) {
  const { ghlClient: g, shopify: s, db } = ctx;
  const contact = (id, email, extra = {}) => g.contacts.set(id, { id, email, ...extra });

  // 1. historical signer matched by stored cross-platform id, flag not yet set -> newly_signed
  contact('c_hist', 'hist@clinic-a.test');
  s.add({ id: gid(1), email: 'hist@clinic-a.test', tags: ['wholesale'], ghlContactId: 'c_hist' });
  g.docs.push(makeDoc({ id: 'd_hist', contactId: 'c_hist', email: 'hist@clinic-a.test', ...SIGNED }));
  // ...plus an older unsigned duplicate invitation for the same provider
  g.docs.push(makeDoc({ id: 'd_hist_old', contactId: 'c_hist', email: 'hist@clinic-a.test', createdAt: '2025-01-05T00:00:00Z' }));

  // 2. already signed in Shopify -> already_signed (matched by unique email)
  contact('c_done', 'done@clinic-b.test');
  s.add({ id: gid(2), email: 'done@clinic-b.test', tags: ['wholesale'], signed: true });
  g.docs.push(makeDoc({ id: 'd_done', contactId: 'c_done', email: 'done@clinic-b.test', ...SIGNED }));

  // 3. signer with no Shopify customer yet -> missing
  contact('c_missing', 'new@clinic-c.test');
  g.docs.push(makeDoc({ id: 'd_missing', contactId: 'c_missing', email: 'new@clinic-c.test', ...SIGNED }));

  // 4. shared practice email (two GHL contacts) -> ambiguous
  contact('c_shared1', 'office@practice.test');
  contact('c_shared2', 'office@practice.test');
  s.add({ id: gid(4), email: 'office@practice.test', tags: ['wholesale'] });
  g.docs.push(makeDoc({ id: 'd_shared', contactId: 'c_shared1', email: 'office@practice.test', ...SIGNED }));

  // 5. unsigned provider -> not_signed
  contact('c_unsigned', 'pending@clinic-d.test');
  s.add({ id: gid(5), email: 'pending@clinic-d.test', tags: ['wholesale'] });
  g.docs.push(makeDoc({ id: 'd_unsigned', contactId: 'c_unsigned', email: 'pending@clinic-d.test', status: 'viewed' }));

  // 6. signed, but document identity only matches by name -> unresolved
  contact('c_nameonly', 'nameonly@clinic-e.test');
  g.docs.push(makeDoc({ id: 'd_nameonly', contactId: 'c_nameonly', email: 'nameonly@clinic-e.test', ...SIGNED }));

  // 7. completed without signed timestamp -> unresolved
  contact('c_nodate', 'nodate@clinic-f.test');
  s.add({ id: gid(7), email: 'nodate@clinic-f.test', tags: ['wholesale'] });
  g.docs.push(makeDoc({ id: 'd_nodate', contactId: 'c_nodate', email: 'nodate@clinic-f.test', hasCompleted: true }));

  // 8. unrelated document -> ignored entirely
  g.docs.push(makeDoc({ id: 'd_w9', name: 'W-9 Request', contactId: 'c_hist', email: 'hist@clinic-a.test', ...SIGNED }));

  // Reviewed mappings for the agreement documents (historical docs carry no template id).
  for (const id of ['d_hist', 'd_hist_old', 'd_done', 'd_missing', 'd_shared', 'd_unsigned', 'd_nodate']) {
    await repo.upsertMapping(db, { documentId: id, isAgreement: true, source: 'reviewed_import' });
  }
}

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'abm-bf-'));

test('date windows cover start..upperBound without gaps', () => {
  const w = buildWindows('2024-01-01T00:00:00Z', '2024-04-15T00:00:00Z', 31);
  assert.equal(w[0].dateFrom, '2024-01-01T00:00:00.000Z');
  assert.equal(w.at(-1).dateTo, '2024-04-15T00:00:00.000Z');
  for (let i = 1; i < w.length; i++) assert.equal(w[i].dateFrom, w[i - 1].dateTo);
});

test('dry run (default) reports every category and writes nothing to Shopify', async () => {
  const ctx = await setup();
  await seed(ctx);
  const dir = await tmp();
  const r = await runBackfill({ ...ctx, reportDir: dir, now: new Date('2026-01-01T00:00:00Z') });

  assert.equal(r.mode, 'dry_run');
  assert.deepEqual(ctx.shopify.writes, [], 'no Shopify writes in dry run');
  const vs = await ctx.db.query('SELECT count(*)::int n FROM verified_signatures');
  assert.equal(vs.rows[0].n, 0, 'dry run does not record signatures the live sync would apply');

  const c = r.summary.byContact;
  assert.equal(c.newly_signed, 1);
  assert.equal(c.already_signed, 1);
  assert.equal(c.missing, 1);
  assert.equal(c.ambiguous, 1);
  assert.equal(c.not_signed, 1);
  assert.equal(c.unresolved, 2);
  assert.equal(c.failed, 0);
  assert.equal(r.summary.matched, 2);

  const rows = parseCsv(await readFile(r.files[1], 'utf8'));
  assert.ok(!rows.some((x) => x.document_id === 'd_w9'), 'unrelated documents are not reported');
  const csvText = await readFile(r.files[1], 'utf8');
  assert.ok(!/@/.test(csvText), 'report contains no email addresses');
  const review = parseCsv(await readFile(r.files[2], 'utf8'));
  assert.deepEqual(review.map((x) => x.document_id).sort(), ['d_nameonly', 'd_nodate']);
});

test('apply writes verified signatures idempotently; restart is a no-op', async () => {
  const ctx = await setup();
  await seed(ctx);
  ctx.shopify.customers.get(gid(1)).tags.push('provider-agreement-pending');
  const dir = await tmp();

  const r1 = await runBackfill({ ...ctx, mode: 'apply', reportDir: dir });
  assert.equal(r1.summary.byContact.newly_signed, 1);
  assert.equal(ctx.shopify.customers.get(gid(1)).signed, true);
  assert.ok(!ctx.shopify.customers.get(gid(1)).tags.includes('provider-agreement-pending'), 'pending tag removed after true');
  assert.equal(ctx.shopify.customers.get(gid(5)).signed, null, 'unsigned provider untouched by backfill');
  assert.equal(ctx.shopify.customers.get(gid(4)).signed, null, 'ambiguous identity not written');

  // Signature for the provider with no Shopify customer is kept for later.
  const pending = await repo.signatureByContact(ctx.db, 'c_missing');
  assert.ok(pending && !pending.applied_at);

  const writesBefore = ctx.shopify.writes.length;
  const r2 = await runBackfill({ ...ctx, mode: 'apply', reportDir: dir });
  assert.notEqual(r2.runId, r1.runId);
  assert.equal(r2.summary.byContact.newly_signed, 0);
  assert.equal(r2.summary.byContact.already_signed, 2);
  assert.equal(ctx.shopify.writes.filter((w) => w.op === 'setSigned').length, ctx.shopify.writes.slice(0, writesBefore).filter((w) => w.op === 'setSigned').length, 'no duplicate true writes');
});

test('a failed run resumes from its checkpoint without reprocessing', async () => {
  const ctx = await setup();
  await seed(ctx);
  const dir = await tmp();
  // Fail after the first page (page size 2, retries exhausted at client level -> surfaced error).
  let calls = 0;
  const realPages = ctx.ghl.pages;
  ctx.ghl.pages = async function* (opts) {
    for await (const p of realPages(opts)) {
      if (++calls === 2) throw new Error('GHL unavailable');
      yield p;
    }
  };
  await assert.rejects(runBackfill({ ...ctx, reportDir: dir, now: new Date('2026-01-01T00:00:00Z') }), /GHL unavailable/);
  const run = (await ctx.db.query('SELECT * FROM backfill_runs')).rows[0];
  assert.equal(run.status, 'failed');
  assert.ok(run.checkpoint.skip > 0 || run.checkpoint.windowIndex > 0, 'checkpoint persisted');
  const recordsAfterFailure = (await ctx.db.query('SELECT count(*)::int n FROM backfill_records')).rows[0].n;

  ctx.ghl.pages = realPages;
  const r = await runBackfill({ ...ctx, reportDir: dir, now: new Date('2026-06-01T00:00:00Z') });
  assert.equal(r.runId, run.id, 'resumed the same run');
  const total = (await ctx.db.query('SELECT count(*)::int n FROM backfill_records')).rows[0].n;
  assert.ok(total >= recordsAfterFailure);
  assert.equal(r.summary.byContact.newly_signed, 1);
  assert.equal(r.summary.byContact.unresolved, 2);
});

test('new signatures arriving during a run do not shift pages (frozen upper bound)', async () => {
  const ctx = await setup();
  await seed(ctx);
  const dir = await tmp();
  const realPages = ctx.ghl.pages;
  let injected = false;
  ctx.ghl.pages = async function* (opts) {
    for await (const p of realPages(opts)) {
      if (!injected) {
        injected = true;
        // A brand-new signature lands mid-run (created "now", after the frozen upper bound).
        ctx.ghlClient.docs.unshift(makeDoc({ id: 'd_live', contactId: 'c_live', email: 'live@x.test', ...SIGNED, createdAt: '2026-01-02T00:00:00Z' }));
      }
      yield p;
    }
  };
  const r = await runBackfill({ ...ctx, reportDir: dir, now: new Date('2026-01-01T00:00:00Z') });
  assert.equal(r.summary.byContact.newly_signed, 1);
  assert.equal(r.summary.byContact.unresolved, 2);
  const live = await ctx.db.query(`SELECT 1 FROM backfill_records WHERE document_id='d_live'`);
  assert.equal(live.rows.length, 0, 'left to the ongoing sync');
});

test('older/duplicate invitations never downgrade a verified signature', async () => {
  const ctx = await setup();
  await seed(ctx);
  await runBackfill({ ...ctx, mode: 'apply', reportDir: await tmp() });
  // A newer re-sent invitation (unsigned) appears for the same provider.
  ctx.ghlClient.docs.push(makeDoc({ id: 'd_hist_resent', contactId: 'c_hist', email: 'hist@clinic-a.test', createdAt: '2025-06-01T00:00:00Z' }));
  await repo.upsertMapping(ctx.db, { documentId: 'd_hist_resent', isAgreement: true, source: 'reviewed_import' });
  // An even later signature on a duplicate must not move the recorded (earliest) signed_at.
  await repo.recordSignature(ctx.db, { contactId: 'c_hist', documentId: 'd_dup', recipientId: 'c_hist', email: 'hist@clinic-a.test', signedAt: '2025-09-01T00:00:00Z', via: 'reviewed_import' });
  const sig = await repo.signatureByContact(ctx.db, 'c_hist');
  assert.equal(sig.document_id, 'd_hist');
  assert.equal(new Date(sig.signed_at).toISOString(), '2025-03-02T12:00:00.000Z');

  await ctx.sync.initCustomer(gid(1));
  assert.equal(ctx.shopify.customers.get(gid(1)).signed, true);
  assert.ok(!ctx.shopify.customers.get(gid(1)).tags.includes('provider-agreement-pending'));
});

test('reviewed mapping import resolves name-only documents on the next run', async () => {
  const ctx = await setup();
  await seed(ctx);
  ctx.shopify.add({ id: gid(6), email: 'nameonly@clinic-e.test', tags: ['wholesale'] });
  const dir = await tmp();
  const r1 = await runBackfill({ ...ctx, reportDir: dir });
  assert.ok((await readFile(r1.files[2], 'utf8')).includes('d_nameonly'));
  await repo.upsertMapping(ctx.db, { documentId: 'd_nameonly', isAgreement: true, source: 'reviewed_import' });
  const r2 = await runBackfill({ ...ctx, reportDir: dir });
  assert.equal(r2.summary.byContact.newly_signed, 2);
  assert.equal(r2.summary.byContact.unresolved, 1);
});
