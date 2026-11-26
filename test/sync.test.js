import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { runOneJob } from '../src/sync/jobs.js';
import { repo } from '../src/sync/repo.js';
import { signAppProxyForTest } from '../src/shopify/verify.js';
import { gid, makeDoc, setup } from './helpers.js';

const SIGNED = { hasCompleted: true, signedDate: '2026-11-20T09:00:00Z' };

function invoke(handle, { method = 'GET', url, headers = {}, body = '' }) {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, { method, url, headers });
    const res = {
      status: 0,
      headers: {},
      writeHead(s, h) {
        this.status = s;
        this.headers = h;
      },
      end(b) {
        let parsed = b;
        try {
          parsed = JSON.parse(b);
        } catch {}
        resolve({ status: this.status, headers: this.headers, body: parsed });
      },
    };
    handle(req, res);
  });
}

function proxyUrl(ctx, action, customerNumericId, extra = {}) {
  const params = { shop: ctx.cfg.shopify.shop, path_prefix: '/apps/provider-agreement', timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: customerNumericId ? String(customerNumericId) : '', ...extra };
  const signature = signAppProxyForTest(params, ctx.cfg.shopify.clientSecret);
  return `/proxy/${action}?${new URLSearchParams({ ...params, signature })}`;
}

const drain = async (ctx) => {
  while (await runOneJob(ctx.jobs, ctx.handlers));
};

async function seedProvider(ctx, n, contactId, email, opts = {}) {
  ctx.ghlClient.contacts.set(contactId, { id: contactId, email });
  if (opts.customer !== false) ctx.shopify.add({ id: gid(n), email, tags: ['wholesale'], ...(opts.customer ?? {}) });
}

const ghlEvent = (ctx, body, secret = ctx.cfg.ghl.webhookSecret) =>
  invoke(createApp(ctx), { method: 'POST', url: '/webhooks/ghl/agreement', headers: { 'x-abm-webhook-secret': secret, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('new unsigned provider: initialized false + pending tag after checking for a signature', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 10, 'c10', 'p10@x.test');
  ctx.ghlClient.docs.push(makeDoc({ id: 'd10', contactId: 'c10', email: 'p10@x.test', status: 'sent' }));
  const r = await ctx.sync.initCustomer(gid(10));
  assert.equal(r.outcome, 'initialized');
  const c = ctx.shopify.customers.get(gid(10));
  assert.equal(c.signed, false);
  assert.ok(c.tags.includes('provider-agreement-pending'));
  assert.ok(ctx.ghlClient.calls.listDocuments > 0, 'checked GHL for an existing signature first');
});

test('retail (non-provider) customers are never initialized or tagged', async () => {
  const ctx = await setup();
  ctx.shopify.add({ id: gid(11), email: 'retail@x.test', tags: [] });
  assert.equal((await ctx.sync.initCustomer(gid(11))).outcome, 'not_provider');
  assert.deepEqual(ctx.shopify.writes, []);
});

test('GHL workflow event -> verified against GHL -> true, then pending tag removed', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 12, 'c12', 'p12@x.test');
  await ctx.sync.initCustomer(gid(12));
  ctx.ghlClient.docs.push(makeDoc({ id: 'd12', contactId: 'c12', email: 'p12@x.test', ...SIGNED }));

  const res = await ghlEvent(ctx, { contact_id: 'c12', document_id: 'd12', location_id: 'loc_1' });
  assert.equal(res.status, 202);
  await drain(ctx);
  const c = ctx.shopify.customers.get(gid(12));
  assert.equal(c.signed, true);
  assert.ok(!c.tags.includes('provider-agreement-pending'));
  const ops = ctx.shopify.writes.filter((w) => w.id === gid(12)).map((w) => w.op);
  assert.ok(ops.lastIndexOf('setSigned') < ops.lastIndexOf('removeTag'), 'true is written before the tag is removed');
  const m = (await repo.loadMappings(ctx.db, ['d12'])).get('d12');
  assert.equal(m.source, 'workflow_event');
});

test('workflow event: falls back to a date scan when GHL search does not match emails', async () => {
  const ctx = await setup({ SHOPIFY_WRITES_ENABLED: 'true' });
  ctx.ghlClient.queryMatchesEmail = false;
  await seedProvider(ctx, 30, 'c30', 'p30@x.test');
  const recent = new Date(Date.now() - 20 * 86400_000).toISOString(); // outside 14d, inside 120d
  ctx.ghlClient.docs.push(makeDoc({ id: 'd30', contactId: 'c30', email: 'p30@x.test', createdAt: recent, ...SIGNED }));

  const docs = await ctx.sync.documentsForContact('c30', 'p30@x.test');
  assert.equal(docs.via, 'date_scan_120d');
  await ghlEvent(ctx, { contact_id: 'c30', location_id: 'loc_1' });
  await drain(ctx);
  assert.equal(ctx.shopify.customers.get(gid(30)).signed, true);
});

test('workflow event is only a hint: an unsigned recipient is not granted access', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 13, 'c13', 'p13@x.test');
  ctx.ghlClient.docs.push(makeDoc({ id: 'd13', contactId: 'c13', email: 'p13@x.test', status: 'completed', hasCompleted: false }));
  await ghlEvent(ctx, { contact_id: 'c13', document_id: 'd13' });
  await drain(ctx);
  assert.notEqual(ctx.shopify.customers.get(gid(13)).signed, true);
});

test('GHL webhook authentication and location scoping', async () => {
  const ctx = await setup();
  assert.equal((await ghlEvent(ctx, { contact_id: 'x' }, 'wrong')).status, 401);
  assert.equal((await ghlEvent(ctx, { contact_id: 'x', location_id: 'other' })).status, 202);
  assert.equal((await ctx.jobs.stats()).pending ?? 0, 0, 'other location ignored');
  assert.equal((await ghlEvent(ctx, { email: 'no-contact@x.test' })).status, 400);

  // Ed25519 X-GHL-Signature path
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const { verifyGhlEvent } = await import('../src/ghl/verify-webhook.js');
  const raw = Buffer.from(JSON.stringify({ contactId: 'c1' }));
  const sig = crypto.sign(null, raw, privateKey).toString('base64');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(verifyGhlEvent({ headers: { 'x-ghl-signature': sig }, rawBody: raw, secret: 's', publicKeyPem: pem }).ok, true);
  assert.equal(verifyGhlEvent({ headers: { 'x-ghl-signature': sig }, rawBody: Buffer.from('{}'), secret: 's', publicKeyPem: pem }).ok, false);
});

test('duplicate events are deduplicated and idempotent', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 14, 'c14', 'p14@x.test');
  ctx.ghlClient.docs.push(makeDoc({ id: 'd14', contactId: 'c14', email: 'p14@x.test', ...SIGNED }));
  for (let i = 0; i < 3; i++) await ghlEvent(ctx, { contact_id: 'c14', document_id: 'd14' });
  assert.equal((await ctx.jobs.stats()).pending, 1, 'queued once');
  await drain(ctx);
  await ghlEvent(ctx, { contact_id: 'c14', document_id: 'd14' }); // late duplicate after processing
  await drain(ctx);
  assert.equal(ctx.shopify.writes.filter((w) => w.op === 'setSigned').length, 1);
});

test('signing before the Shopify customer exists is applied on customer creation', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 15, 'c15', 'early@x.test', { customer: false });
  ctx.ghlClient.docs.push(makeDoc({ id: 'd15', contactId: 'c15', email: 'early@x.test', ...SIGNED }));
  await ghlEvent(ctx, { contact_id: 'c15', document_id: 'd15' });
  await drain(ctx);
  const sig = await repo.signatureByContact(ctx.db, 'c15');
  assert.ok(sig && !sig.applied_at, 'verified signature waits for the customer');

  // GHL registration workflow creates the Shopify customer -> customers/create webhook.
  ctx.shopify.add({ id: gid(15), email: 'early@x.test', tags: ['wholesale'] });
  const body = JSON.stringify({ id: 15, admin_graphql_api_id: gid(15) });
  const hmac = crypto.createHmac('sha256', ctx.cfg.shopify.clientSecret).update(body).digest('base64');
  const app = createApp(ctx);
  const bad = await invoke(app, { method: 'POST', url: '/webhooks/shopify', headers: { 'x-shopify-hmac-sha256': 'nope', 'x-shopify-topic': 'customers/create' }, body });
  assert.equal(bad.status, 401);
  const ok = await invoke(app, { method: 'POST', url: '/webhooks/shopify', headers: { 'x-shopify-hmac-sha256': hmac, 'x-shopify-topic': 'customers/create' }, body });
  assert.equal(ok.status, 200);
  await ctx.db.query(`UPDATE sync_jobs SET run_at = now()`);
  await drain(ctx);
  const c = ctx.shopify.customers.get(gid(15));
  assert.equal(c.signed, true);
  assert.ok(!c.tags.includes('provider-agreement-pending'), 'never tagged pending');
  assert.ok(!ctx.shopify.writes.some((w) => w.op === 'initUnsigned' && w.id === gid(15)), 'never initialized to false');
});

test('a delayed initialization cannot undo verified access', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 16, 'c16', 'p16@x.test');
  ctx.ghlClient.docs.push(makeDoc({ id: 'd16', contactId: 'c16', email: 'p16@x.test', ...SIGNED }));
  await repo.upsertMapping(ctx.db, { documentId: 'd16', isAgreement: true, source: 'workflow_event' });
  await ctx.sync.syncContact('c16');
  assert.equal(ctx.shopify.customers.get(gid(16)).signed, true);
  // Late customers/update -> init job runs after the signature.
  const r = await ctx.sync.initCustomer(gid(16));
  assert.equal(r.outcome, 'already_signed');
  assert.equal(ctx.shopify.customers.get(gid(16)).signed, true);
  assert.ok(!ctx.shopify.customers.get(gid(16)).tags.includes('provider-agreement-pending'));

  // Race: init read "missing" before the signature landed; compareDigest:null create-only write loses.
  ctx.shopify.add({ id: gid(17), email: 'p17@x.test', tags: ['wholesale'], signed: true });
  assert.equal(await ctx.shopify.initUnsigned(gid(17)), 'exists');
  assert.equal(ctx.shopify.customers.get(gid(17)).signed, true);
});

test('partial write: tag cleanup failure is retried and access stays granted', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 18, 'c18', 'p18@x.test');
  await ctx.sync.initCustomer(gid(18));
  ctx.ghlClient.docs.push(makeDoc({ id: 'd18', contactId: 'c18', email: 'p18@x.test', ...SIGNED }));
  await repo.upsertMapping(ctx.db, { documentId: 'd18', isAgreement: true, source: 'workflow_event' });
  ctx.shopify.fail.removeTag = 1;
  await ctx.sync.syncContact('c18');
  assert.equal(ctx.shopify.customers.get(gid(18)).signed, true);
  assert.ok(ctx.shopify.customers.get(gid(18)).tags.includes('provider-agreement-pending'));
  await ctx.db.query(`UPDATE sync_jobs SET run_at = now()`);
  await drain(ctx);
  assert.ok(!ctx.shopify.customers.get(gid(18)).tags.includes('provider-agreement-pending'));
});

test('transient setSigned failure: job retries with backoff and succeeds', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 19, 'c19', 'p19@x.test');
  ctx.ghlClient.docs.push(makeDoc({ id: 'd19', contactId: 'c19', email: 'p19@x.test', ...SIGNED }));
  ctx.shopify.fail.setSigned = 1;
  await ghlEvent(ctx, { contact_id: 'c19', document_id: 'd19' });
  await drain(ctx);
  assert.notEqual(ctx.shopify.customers.get(gid(19)).signed, true);
  const job = (await ctx.db.query(`SELECT * FROM sync_jobs WHERE type='verify_contact'`)).rows[0];
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 1);
  await ctx.db.query(`UPDATE sync_jobs SET run_at = now()`);
  await drain(ctx);
  assert.equal(ctx.shopify.customers.get(gid(19)).signed, true);
});

test('reconcile catches missed events and stale pending tags', async () => {
  const ctx = await setup({ AGREEMENT_TEMPLATE_ID: 'tpl_abm' });
  await seedProvider(ctx, 20, 'c20', 'p20@x.test');
  await ctx.sync.initCustomer(gid(20));
  const now = new Date();
  ctx.ghlClient.docs.push(makeDoc({ id: 'd20', contactId: 'c20', email: 'p20@x.test', templateId: 'tpl_abm', hasCompleted: true, signedDate: now.toISOString(), createdAt: new Date(now - 86400_000).toISOString() }));
  // Stale tag on an already-signed customer from an earlier partial write.
  ctx.shopify.add({ id: gid(21), email: 'p21@x.test', tags: ['wholesale', 'provider-agreement-pending'], signed: true });

  assert.equal(await ctx.reconciler.scanRecent(), 1);
  const applied = await ctx.reconciler.applyPending();
  assert.equal(applied.applied, 1);
  assert.equal(ctx.shopify.customers.get(gid(20)).signed, true);
  await ctx.reconciler.cleanupTags();
  assert.ok(!ctx.shopify.customers.get(gid(21)).tags.includes('provider-agreement-pending'));
});

test('ambiguous identity (shared practice email) is not auto-applied', async () => {
  const ctx = await setup();
  ctx.ghlClient.contacts.set('c22a', { id: 'c22a', email: 'front@practice.test' });
  ctx.ghlClient.contacts.set('c22b', { id: 'c22b', email: 'front@practice.test' });
  ctx.shopify.add({ id: gid(22), email: 'front@practice.test', tags: ['wholesale'] });
  ctx.ghlClient.docs.push(makeDoc({ id: 'd22', contactId: 'c22a', email: 'front@practice.test', ...SIGNED }));
  await repo.upsertMapping(ctx.db, { documentId: 'd22', isAgreement: true, source: 'workflow_event' });
  const r = await ctx.sync.syncContact('c22a');
  assert.equal(r.outcome, 'ambiguous');
  assert.notEqual(ctx.shopify.customers.get(gid(22)).signed, true);
});

// ---------------- storefront (app proxy) ----------------

test('app proxy: rejects unsigned/forged requests; guests get not-required', async () => {
  const ctx = await setup();
  const app = createApp(ctx);
  assert.equal((await invoke(app, { url: '/proxy/status?shop=x&logged_in_customer_id=1&timestamp=1&signature=deadbeef' })).status, 401);
  const stale = proxyUrl(ctx, 'status', 1, { timestamp: '1000' });
  assert.equal((await invoke(app, { url: stale })).status, 401);
  const guest = await invoke(app, { url: proxyUrl(ctx, 'status', null) });
  assert.deepEqual(guest.body, { loggedIn: false, required: false });
});

test('app proxy: status, embedded signing link, popup signing, recheck unlock', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 30, 'c30', 'p30@x.test', { customer: { ghlContactId: 'c30' } });
  await ctx.sync.initCustomer(gid(30));
  ctx.ghlClient.docs.push(makeDoc({ id: 'd30', contactId: 'c30', email: 'p30@x.test', status: 'sent' }));
  const app = createApp(ctx);

  const s1 = await invoke(app, { url: proxyUrl(ctx, 'status', 30) });
  assert.deepEqual([s1.body.required, s1.body.signed], [true, false]);
  assert.equal(s1.headers['Cache-Control'], 'no-store');

  const a = await invoke(app, { url: proxyUrl(ctx, 'agreement', 30) });
  assert.equal(a.body.status, 'ready');
  assert.match(a.body.signingUrl, /d30\/c30$/);
  assert.equal(a.body.prefill.email, 'p30@x.test');

  // Provider signs inside the popup; GHL now shows the completed signer recipient.
  Object.assign(ctx.ghlClient.docs[0].recipients[0], SIGNED);
  ctx.ghlClient.docs[0].status = 'completed';
  // Name-only docs need the workflow event (template-filtered) before unlock:
  const before = await invoke(app, { method: 'POST', url: proxyUrl(ctx, 'recheck', 30) });
  assert.equal(before.body.signed, false, 'unverified document identity never unlocks');
  await ghlEvent(ctx, { contact_id: 'c30', document_id: 'd30' });
  await drain(ctx);
  const after = await invoke(app, { method: 'POST', url: proxyUrl(ctx, 'recheck', 30) });
  assert.equal(after.body.signed, true);
});

test('app proxy: template-id deployments unlock directly on recheck', async () => {
  const ctx = await setup({ AGREEMENT_TEMPLATE_ID: 'tpl_abm' });
  await seedProvider(ctx, 31, 'c31', 'p31@x.test', { customer: { ghlContactId: 'c31' } });
  ctx.ghlClient.docs.push(makeDoc({ id: 'd31', contactId: 'c31', email: 'p31@x.test', templateId: 'tpl_abm', ...SIGNED }));
  const app = createApp(ctx);
  const r = await invoke(app, { method: 'POST', url: proxyUrl(ctx, 'recheck', 31) });
  assert.equal(r.body.signed, true);
  assert.equal(ctx.shopify.customers.get(gid(31)).signed, true);
});

test("app proxy: a customer can never receive another provider's signing link", async () => {
  const ctx = await setup();
  await seedProvider(ctx, 32, 'c32', 'p32@x.test', { customer: { ghlContactId: 'c32' } });
  await seedProvider(ctx, 33, 'c33', 'p33@x.test', { customer: { ghlContactId: 'c33' } });
  ctx.ghlClient.docs.push(makeDoc({ id: 'd32', contactId: 'c32', email: 'p32@x.test' }));
  const app = createApp(ctx);
  const r = await invoke(app, { url: proxyUrl(ctx, 'agreement', 33) });
  assert.equal(r.body.status, 'not_found');
  assert.equal(r.body.signingUrl, undefined);
});

test('app proxy: expired invitation -> deduplicated recovery request coordinated via GHL tag', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 34, 'c34', 'p34@x.test', { customer: { ghlContactId: 'c34' } });
  ctx.ghlClient.docs.push(makeDoc({ id: 'd34', contactId: 'c34', email: 'p34@x.test', isExpired: true }));
  const app = createApp(ctx);
  assert.equal((await invoke(app, { url: proxyUrl(ctx, 'agreement', 34) })).body.status, 'expired');
  assert.equal((await invoke(app, { url: proxyUrl(ctx, 'resend', 34) })).status, 405);
  const r1 = await invoke(app, { method: 'POST', url: proxyUrl(ctx, 'resend', 34) });
  const r2 = await invoke(app, { method: 'POST', url: proxyUrl(ctx, 'resend', 34) });
  assert.equal(r1.body.status, 'requested');
  assert.equal(r2.body.status, 'already_requested');
  assert.deepEqual(ctx.ghlClient.calls.addContactTags, [{ id: 'c34', tags: ['provider-agreement-resend'] }]);
  assert.ok(r2.body.supportEmail);
});

test('app proxy: no invitation yet (drip delay) is reported as pending/not found with recovery', async () => {
  const ctx = await setup();
  await seedProvider(ctx, 35, 'c35', 'p35@x.test', { customer: { ghlContactId: 'c35' } });
  const r = await invoke(createApp(ctx), { url: proxyUrl(ctx, 'agreement', 35) });
  assert.equal(r.body.status, 'not_found');
  assert.equal(r.body.dripDelayMinutes, 60);
});

test('app proxy: retail customer is not required to sign', async () => {
  const ctx = await setup();
  ctx.shopify.add({ id: gid(36), email: 'retail@x.test', tags: [] });
  const r = await invoke(createApp(ctx), { url: proxyUrl(ctx, 'status', 36) });
  assert.equal(r.body.required, false);
});

test('health endpoint checks the database', async () => {
  const ctx = await setup();
  const r = await invoke(createApp(ctx), { url: '/healthz' });
  assert.deepEqual([r.status, r.body.ok], [200, true]);
});

test('SHOPIFY_WRITES_ENABLED off (default): nothing is written; verified signatures wait; backfill apply still writes', async () => {
  const ctx = await setup({ SHOPIFY_WRITES_ENABLED: 'false' });
  assert.equal(ctx.cfg.sync.shopifyWrites, false);
  await seedProvider(ctx, 40, 'c40', 'p40@x.test');
  ctx.ghlClient.docs.push(makeDoc({ id: 'd40', contactId: 'c40', email: 'p40@x.test', ...SIGNED }));

  // customers/update webhook: accepted, but no init job queued.
  const body = JSON.stringify({ id: 40, admin_graphql_api_id: gid(40) });
  const hmac = crypto.createHmac('sha256', ctx.cfg.shopify.clientSecret).update(body).digest('base64');
  const r = await invoke(createApp(ctx), { method: 'POST', url: '/webhooks/shopify', headers: { 'x-shopify-hmac-sha256': hmac, 'x-shopify-topic': 'customers/update' }, body });
  assert.equal(r.status, 200);
  assert.equal((await ctx.jobs.stats()).pending ?? 0, 0);
  assert.equal((await ctx.sync.initCustomer(gid(40))).outcome, 'skipped_writes_disabled');

  // GHL workflow event: signature verified and recorded, Shopify untouched.
  await ghlEvent(ctx, { contact_id: 'c40', document_id: 'd40' });
  await drain(ctx);
  assert.deepEqual(ctx.shopify.writes, []);
  const sig = await repo.signatureByContact(ctx.db, 'c40');
  assert.ok(sig && !sig.applied_at);
  assert.equal((await ctx.reconciler.applyPending()).applied, 0);

  // Explicit rollout action still writes.
  assert.equal(await ctx.sync.applySigned(gid(40), 'c40', { force: true }), 'newly_signed');
  assert.equal(ctx.shopify.customers.get(gid(40)).signed, true);
});

test('live shapes: email changed after signing is matched; deleted GHL contact goes to review', async () => {
  const ctx = await setup();
  // Signed with old@, contact now uses new@; Shopify customer was registered with old@.
  ctx.ghlClient.contacts.set('c50', { id: 'c50', email: 'new50@x.test' });
  ctx.shopify.add({ id: gid(50), email: 'old50@x.test', tags: ['wholesale'] });
  const signed = makeDoc({ id: 'd50', contactId: 'c50', email: 'old50@x.test', ...SIGNED });
  await repo.upsertMapping(ctx.db, { documentId: 'd50', isAgreement: true, source: 'reviewed_import' });
  const [ev] = await ctx.sync.evaluateDocs(ctx.db, [signed]);
  const m = await ctx.sync.matchSigner(ev.signers[0]);
  assert.deepEqual([m.status, m.method, m.customer.id], ['matched', 'email_changed_after_signing', gid(50)]);

  // Signer's contact was deleted/merged in GHL (live API: 400 "Contact not found").
  const orphan = makeDoc({ id: 'd51', contactId: 'gone51', email: 'gone51@x.test', ...SIGNED });
  const [ev2] = await ctx.sync.evaluateDocs(ctx.db, [orphan]);
  const m2 = await ctx.sync.matchSigner(ev2.signers[0]);
  assert.deepEqual([m2.status, m2.reason], ['ambiguous', 'ghl_contact_not_found']);
});
