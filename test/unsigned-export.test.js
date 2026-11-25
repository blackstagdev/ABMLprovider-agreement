import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, latestRun, loadDbFacts, NON_PROVIDER_STATUS, STATUS } from '../src/report/unsigned-export.js';
import { newDb } from './helpers.js';

async function seed(db) {
  await db.query(`INSERT INTO backfill_runs (id, mode, location_id, upper_bound, status) VALUES (3, 'dry_run', 'l', now(), 'completed'), (4, 'apply', 'l', now(), 'completed')`);
  const rows = [
    ['d1', 'newly_signed', 'cSigned', 'gid://shopify/Customer/1', { method: 'email' }],
    ['d2', 'not_signed', 'cSent', null, { reason: 'recipient_not_completed' }],
    ['d3', 'not_signed', 'cSent', null, { reason: 'recipient_not_completed' }],
    ['d4', 'ambiguous', 'cAmb', null, { reason: 'shared_email_in_ghl' }],
    ['d5', 'missing', 'cMiss', null, { reason: 'no_shopify_customer' }],
  ];
  for (const [doc, outcome, c, s, detail] of rows) {
    await db.query(`INSERT INTO backfill_records (run_id, document_id, recipient_id, outcome, ghl_contact_id, shopify_customer_id, detail) VALUES (4,$1,$1,$2,$3,$4,$5)`, [doc, outcome, c, s, JSON.stringify(detail)]);
  }
}

const cust = (n, email, tags, signed) => ({ id: `gid://shopify/Customer/${n}`, legacyId: String(n), email, tags, signed, firstName: 'F', lastName: String(n) });

test('export classifies unfilled providers and counts filled customers', async () => {
  const db = await newDb();
  await seed(db);
  const run = await latestRun(db);
  assert.equal(String(run.id), '4');
  const facts = await loadDbFacts(db, run.id);
  assert.equal(facts.written, 1);

  const contactsByEmail = {
    'sent@x.test': [{ id: 'cSent', email: 'sent@x.test' }],
    'amb@x.test': [{ id: 'cAmb', email: 'amb@x.test' }, { id: 'cOther', email: 'amb@x.test' }],
    'new@x.test': [{ id: 'cNew', email: 'new@x.test' }],
  };
  const customers = [
    cust(1, 'signed@x.test', ['wholesale'], true),
    cust(2, 'sent@x.test', ['wholesale'], null),
    cust(3, 'amb@x.test', ['wholesale'], false),
    cust(4, 'new@x.test', ['wholesale'], null),
    cust(5, 'ghost@x.test', ['wholesale'], null),
    cust(6, null, ['wholesale'], null),
    cust(7, 'retail@x.test', [], null),
    cust(8, 'retailsigned@x.test', ['dose'], true),
    cust(9, 'bad@email', ['wholesale'], null),
  ];
  const r = await buildExport({
    customers,
    facts,
    providerTags: ['wholesale'],
    lookupContacts: async (c) => {
      if (c.email === 'bad@email') throw new Error('GHL 400');
      return contactsByEmail[c.email] ?? [];
    },
    getContact: async (id) => (id === 'cMiss' ? { id, email: 'miss@x.test', firstName: 'M' } : null),
    links: { shopifyCustomer: (id) => `s/${id}`, ghlContact: (id) => `g/${id}` },
  });

  assert.deepEqual(r.counts, { customers: 9, signedTrue: 2, providers: 7, providerTrue: 1, providerFalse: 1, providerMissing: 5, nonProviders: 2, signedNotProvider: 1 });
  assert.equal(r.byStatus.lookup_failed, 1);
  const status = Object.fromEntries(r.notFilled.map((x) => [x.shopifyCustomerId, x.status]));
  assert.equal(status['2'], STATUS.sent_not_signed);
  assert.equal(status['3'], STATUS.needs_review);
  assert.equal(status['4'], STATUS.no_agreement);
  assert.equal(status['5'], STATUS.no_ghl_contact);
  assert.equal(status['6'], STATUS.no_email);
  assert.equal(r.notFilled.find((x) => x.shopifyCustomerId === '2').invitations, 2);
  const np = Object.fromEntries(r.nonProviders.map((x) => [x.shopifyCustomerId, x.status]));
  assert.deepEqual(np, { 7: NON_PROVIDER_STATUS.no_ghl_contact, 8: NON_PROVIDER_STATUS.signed });
  assert.equal(r.nonProviderByStatus.signed, 1);
  assert.deepEqual(r.review.map((x) => x.reason), ['shared_email_in_ghl', 'no_shopify_customer']);
  assert.equal(r.review[0].ghlName, '(contact deleted in GHL)');
});
