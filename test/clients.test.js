// Request shapes for the Shopify Admin and GHL clients (fetch is faked; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyAdmin } from '../src/shopify/admin.js';
import { createShopifyCustomers } from '../src/shopify/customers.js';
import { createGhlClient } from '../src/ghl/client.js';
import { verifyAppProxy, signAppProxyForTest } from '../src/shopify/verify.js';
import { redact } from '../src/log.js';
import { newDb, testConfig } from './helpers.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('Shopify: client-credentials token is cached in Postgres; API version pinned', async () => {
  const db = await newDb();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/admin/oauth/access_token')) return json({ access_token: 'tok_1', scope: 'read_customers', expires_in: 86399 });
    return json({ data: { ok: true } });
  };
  const admin = createShopifyAdmin({ shop: 's.myshopify.com', clientId: 'id', clientSecret: 'sec', db, fetchImpl });
  await admin.graphql('{ shop { id } }');
  await admin.graphql('{ shop { id } }');
  assert.equal(calls.filter((c) => c.url.includes('oauth')).length, 1);
  assert.match(calls[0].init.body.toString(), /grant_type=client_credentials/);
  assert.ok(calls[1].url.endsWith('/admin/api/2026-10/graphql.json'));
  assert.equal(calls[1].init.headers['X-Shopify-Access-Token'], 'tok_1');
  const row = (await db.query('SELECT access_token FROM shop_sessions')).rows[0];
  assert.equal(row.access_token, 'tok_1');

  // A second process reuses the stored token.
  const calls2 = [];
  const admin2 = createShopifyAdmin({ shop: 's.myshopify.com', clientId: 'id', clientSecret: 'sec', db, fetchImpl: async (u, i) => (calls2.push(String(u)), json({ data: {} })) });
  await admin2.graphql('{ shop { id } }');
  assert.equal(calls2.filter((u) => u.includes('oauth')).length, 0);
});

function fakeAdmin(responses) {
  const sent = [];
  return {
    sent,
    async graphql(query, variables) {
      sent.push({ query, variables });
      const next = responses.shift();
      return typeof next === 'function' ? next(query, variables) : next;
    },
  };
}
const cust = (signed) => ({ customer: { id: 'gid://shopify/Customer/1', email: 'a@x.test', tags: ['wholesale'], signed: signed === null ? null : { value: String(signed) }, ghl: { value: 'c1' } } });

test('Shopify: initUnsigned is create-only (compareDigest null) and setSigned reads back', async () => {
  const cfg = testConfig().shopify;
  const admin = fakeAdmin([{ metafieldsSet: { metafields: [{ value: 'false' }], userErrors: [] } }, { metafieldsSet: { metafields: [{ value: 'true' }], userErrors: [] } }, cust(true)]);
  const s = createShopifyCustomers(admin, cfg);
  assert.equal(await s.initUnsigned('gid://shopify/Customer/1'), 'created');
  const m = admin.sent[0].variables.m[0];
  assert.deepEqual(m, { ownerId: 'gid://shopify/Customer/1', namespace: 'custom', key: 'provider_agreement_signed', type: 'boolean', value: 'false', compareDigest: null });
  const after = await s.setSigned('gid://shopify/Customer/1');
  assert.equal(after.signed, true);
  assert.equal(after.ghlContactId, 'c1');
});

test('Shopify: initUnsigned reports an existing value instead of overwriting it', async () => {
  const admin = fakeAdmin([{ metafieldsSet: { metafields: [], userErrors: [{ code: 'STALE_OBJECT', message: 'stale' }] } }]);
  assert.equal(await createShopifyCustomers(admin, testConfig().shopify).initUnsigned('gid://shopify/Customer/1'), 'exists');
});

test('Shopify: setSigned throws if true does not read back (job will retry)', async () => {
  const admin = fakeAdmin([{ metafieldsSet: { metafields: [], userErrors: [] } }, cust(false)]);
  await assert.rejects(createShopifyCustomers(admin, testConfig().shopify).setSigned('gid://shopify/Customer/1'), /did not read back/);
});

test('Shopify: findByEmail filters to an exact normalized match', async () => {
  const admin = fakeAdmin([{ customers: { nodes: [{ id: '1', email: 'A@x.test', tags: [] }, { id: '2', email: 'a@x.test.evil', tags: [] }] } }]);
  const r = await createShopifyCustomers(admin, testConfig().shopify).findByEmail(' a@X.test ');
  assert.deepEqual(r.map((c) => c.id), ['1']);
});

test('GHL: documented endpoint, Version header, retries on 429 then succeeds', async () => {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return ++n === 1 ? json({}, 429, { 'retry-after': '0' }) : json({ documents: [], total: 0 });
  };
  const c = createGhlClient({ token: 't', locationId: 'loc_1', requestsPerSecond: 1000, fetchImpl });
  const r = await c.listDocuments({ limit: 50, skip: 100, dateFrom: '2025-01-01T00:00:00Z', dateTo: '2025-02-01T00:00:00Z' });
  assert.equal(r.total, 0);
  assert.equal(calls.length, 2);
  const u = calls[1].url;
  assert.equal(u.pathname, '/proposals/document');
  assert.equal(u.searchParams.get('locationId'), 'loc_1');
  assert.equal(u.searchParams.get('skip'), '100');
  assert.equal(calls[1].init.headers.Version, 'v3');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer t');
});

test('GHL: non-retryable errors surface without leaking the token', async () => {
  const c = createGhlClient({ token: 'secret-token', locationId: 'l', requestsPerSecond: 1000, fetchImpl: async () => json({}, 401) });
  await assert.rejects(c.listDocuments(), (e) => e.status === 401 && !e.message.includes('secret-token'));
});

test('app proxy signature: multi-value params joined with commas, sorted', () => {
  const secret = 'hush';
  const ts = String(Math.floor(Date.now() / 1000));
  const sp = new URLSearchParams([['shop', 's.myshopify.com'], ['logged_in_customer_id', '42'], ['timestamp', ts], ['extra', '1'], ['extra', '2']]);
  const msg = ['extra=1,2', 'logged_in_customer_id=42', 'shop=s.myshopify.com', `timestamp=${ts}`].sort().join('');
  const crypto = globalThis.crypto && null; // keep lint quiet
  void crypto;
  const sig = signAppProxyForTest({ extra: '1,2', logged_in_customer_id: '42', shop: 's.myshopify.com', timestamp: ts }, secret);
  sp.set('signature', sig);
  const r = verifyAppProxy(sp, secret);
  assert.equal(r.ok, true, msg);
  assert.equal(r.customerId, 'gid://shopify/Customer/42');
});

test('logger redacts PII, tokens and signing links', () => {
  const out = redact({ email: 'a@x.test', shareLink: 'https://x', nested: { firstName: 'A', documentId: 'd1' }, access_token: 't' });
  assert.deepEqual(out, { email: '[redacted]', shareLink: '[redacted]', nested: { firstName: '[redacted]', documentId: 'd1' }, access_token: '[redacted]' });
});

test('GHL: 422 errors carry GHL’s reason, with emails masked', async () => {
  const body = { statusCode: 422, message: ['limit must not be greater than 50', 'bad value a.b@clinic.test'], error: 'Unprocessable Entity' };
  const c = createGhlClient({ token: 't', locationId: 'l', requestsPerSecond: 1000, fetchImpl: async () => json(body, 422) });
  await assert.rejects(c.listDocuments({ limit: 100 }), (e) => {
    assert.equal(e.status, 422);
    assert.match(e.message, /failed with 422: limit must not be greater than 50; bad value \[email\]/);
    assert.ok(!e.message.includes('clinic.test'));
    return true;
  });
});

test('GHL: email search pages by documents returned, not a fixed 100', async () => {
  const { createGhlService } = await import('../src/ghl/service.js');
  const all = Array.from({ length: 7 }, (_, i) => ({ documentId: `d${i}` }));
  const seen = [];
  const client = { listDocuments: async ({ limit, skip }) => (seen.push([limit, skip]), { documents: all.slice(skip, skip + limit), total: all.length }) };
  const docs = await createGhlService(client, { pageSize: 3 }).documentsForEmail('a@x.test');
  assert.equal(docs.length, 7);
  assert.deepEqual(seen, [[3, 0], [3, 3], [3, 6]]);
});
