import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBackfill } from '../src/backfill/run.js';
import { approveNameMatches, latestDryRun, previewNameMatches, templatesWithName } from '../src/backfill/approve.js';
import { repo } from '../src/sync/repo.js';
import { gid, makeDoc, setup } from './helpers.js';

const SIGNED = { hasCompleted: true, signedDate: '2025-03-02T12:00:00Z' };

async function seedNameOnly(ctx) {
  const g = ctx.ghlClient;
  g.contacts.set('c1', { id: 'c1', email: 'one@x.test' });
  g.contacts.set('c2', { id: 'c2', email: 'two@x.test' });
  g.contacts.set('c3', { id: 'c3', email: 'three@x.test' });
  ctx.shopify.add({ id: gid(1), email: 'one@x.test', tags: ['wholesale'] });
  ctx.shopify.add({ id: gid(2), email: 'two@x.test', tags: ['wholesale'], signed: true });
  g.docs.push(makeDoc({ id: 'n1', contactId: 'c1', email: 'one@x.test', ...SIGNED }));
  g.docs.push(makeDoc({ id: 'n2', contactId: 'c2', email: 'two@x.test', ...SIGNED }));
  g.docs.push(makeDoc({ id: 'n3', contactId: 'c3', email: 'three@x.test', status: 'sent' }));
  g.docs.push(makeDoc({ id: 'other', name: 'Alpha BioMed Provider Agreement v0 (old)', contactId: 'c1', email: 'one@x.test', ...SIGNED }));
}

test('preview counts, approve writes reviewed mappings once, re-run resolves real outcomes', async () => {
  const ctx = await setup();
  await seedNameOnly(ctx);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'abm-ap-'));
  const r1 = await runBackfill({ ...ctx, reportDir: dir });
  assert.equal(r1.summary.byContact.unresolved, 3);
  assert.equal(await latestDryRun(ctx.db), r1.runId);

  const p = await previewNameMatches(ctx.db, r1.runId);
  assert.equal(p.nameMatchDocuments, 3);
  assert.equal(p.nameMatchSignedDocuments, 2);
  assert.equal(p.nameMatchSignedContacts, 2);
  assert.equal((await ctx.db.query('SELECT count(*)::int n FROM document_mappings')).rows[0].n, 0, 'preview writes nothing');

  const a = await approveNameMatches(ctx.db, r1.runId, { approvedBy: 'Tester', now: new Date('2026-11-26T00:00:00Z') });
  assert.deepEqual([a.documents, a.newMappings], [3, 3]);
  assert.match(a.note, /dry run \d+ by Tester on 2026-11-26/);
  assert.equal((await approveNameMatches(ctx.db, r1.runId, { approvedBy: 'Tester' })).newMappings, 0, 'idempotent');
  const m = (await repo.loadMappings(ctx.db, ['other'])).get('other');
  assert.equal(m, undefined, 'a different name is never approved');

  const r2 = await runBackfill({ ...ctx, reportDir: dir });
  assert.notEqual(r2.runId, r1.runId);
  assert.equal(r2.summary.byContact.newly_signed, 1);
  assert.equal(r2.summary.byContact.already_signed, 1);
  assert.equal(r2.summary.byContact.not_signed, 1);
  assert.equal(r2.summary.byContact.unresolved, 0);
  assert.deepEqual(ctx.shopify.writes, [], 'still a dry run');
});

test('a reviewed rejection is not overridden by bulk approval', async () => {
  const ctx = await setup();
  await seedNameOnly(ctx);
  const r1 = await runBackfill({ ...ctx, reportDir: await mkdtemp(path.join(os.tmpdir(), 'abm-ap-')) });
  await repo.upsertMapping(ctx.db, { documentId: 'n1', isAgreement: false, source: 'reviewed_import', note: 'not ours' });
  const a = await approveNameMatches(ctx.db, r1.runId, { approvedBy: 'Tester' });
  assert.equal(a.newMappings, 2);
  assert.equal((await repo.loadMappings(ctx.db, ['n1'])).get('n1').is_agreement, false);
});

test('template-name uniqueness check reports duplicates and scope errors', async () => {
  const two = { listTemplates: async () => ({ data: [{ name: 'Alpha BioMed Provider Agreement' }, { name: 'alpha biomed provider agreement ' }, { name: 'Other' }], total: 3 }) };
  assert.deepEqual(await templatesWithName(two, 'Alpha BioMed Provider Agreement'), { ok: true, exact: 2, total: 3 });
  const denied = { listTemplates: async () => { throw Object.assign(new Error('x'), { status: 401, ghlReason: 'scope' }); } };
  assert.deepEqual(await templatesWithName(denied, 'A'), { ok: false, error: 'HTTP 401 scope' });
});
