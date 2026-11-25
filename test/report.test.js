import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameApprover, runReport } from '../src/backfill/report.js';
import { approveNameMatches } from '../src/backfill/approve.js';
import { newDb } from './helpers.js';

async function seed(db) {
  await db.query(`INSERT INTO backfill_runs (id, mode, location_id, upper_bound, status) VALUES (7, 'dry_run', 'l', now(), 'completed')`);
  const rows = [
    ['d1', 'r1', 'newly_signed', 'c1', 'S1', { method: 'email' }],
    ['d2', 'r2', 'ambiguous', 'c2', null, { reason: 'shared_email_in_ghl' }],
    ['d3', 'r3', 'ambiguous', 'c3', null, { reason: 'recipient_email_differs_from_contact' }],
    ['d4', 'r4', 'failed', 'c4', null, { error: 'GHL GET /contacts/x failed with 500 for who@x.test' }],
    ['d5', '-', 'unresolved', null, null, { reason: 'no_contact_signer' }],
    ['d6', 'r6', 'unresolved', 'c6', null, { reason: 'name_match_only' }],
    ['d7', 'r7', 'missing', 'c7', null, { reason: 'no_shopify_customer' }],
  ];
  for (const [doc, rec, outcome, c, s, detail] of rows) {
    await db.query(`INSERT INTO backfill_records (run_id, document_id, recipient_id, outcome, ghl_contact_id, shopify_customer_id, detail) VALUES (7,$1,$2,$3,$4,$5,$6)`, [doc, rec, outcome, c, s, JSON.stringify(detail)]);
  }
}

test('report groups by outcome and reason, lists review rows, masks emails', async () => {
  const db = await newDb();
  await seed(db);
  const r = await runReport(db, 7);
  const amb = r.byReason.filter((x) => x.outcome === 'ambiguous').map((x) => x.reason).sort();
  assert.deepEqual(amb, ['recipient_email_differs_from_contact', 'shared_email_in_ghl']);
  assert.deepEqual(r.review.map((x) => x.document_id).sort(), ['d2', 'd3', 'd4', 'd6', 'd7']);
  assert.ok(!JSON.stringify(r).includes('who@x.test'));
  assert.match(r.failures[0].error, /\[email\]/);
});

test('rename approver on bulk mappings', async () => {
  const db = await newDb();
  await seed(db);
  await db.query(`UPDATE backfill_records SET outcome='unresolved', detail='{"reason":"name_match_only"}' WHERE document_id IN ('d1','d2')`);
  await approveNameMatches(db, 7, { approvedBy: 'Your Name', now: new Date('2026-11-26T00:00:00Z') });
  assert.equal(await renameApprover(db, 'Your Name', 'Real Name'), 3);
  const notes = (await db.query('SELECT DISTINCT note FROM document_mappings')).rows.map((r) => r.note);
  assert.deepEqual(notes, ['bulk exact-name approval of dry run 7 by Real Name on 2026-11-26']);
});
