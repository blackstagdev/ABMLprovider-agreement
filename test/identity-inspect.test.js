import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeIdentity } from '../src/domain/identity-inspect.js';
import { loadConfig, requireKeys } from '../src/config.js';

const sample = (n, { meta = [], fields = [], ghlMatches = 1, note = '' } = {}) => ({
  customer: { id: `gid://shopify/Customer/${n}`, note, metafields: meta },
  ghlContact: ghlMatches === 1 ? { id: `ghl${n}abcdefghijklmnop`, customFields: fields } : null,
  ghlMatches,
});

test('finds a Shopify metafield holding the GHL contact id', () => {
  const s = [1, 2, 3].map((n) => sample(n, { meta: [{ namespace: 'gohighlevel', key: 'contact_id', value: `ghl${n}abcdefghijklmnop` }, { namespace: 'custom', key: 'npi', value: '123' }] }));
  const r = analyzeIdentity(s);
  assert.match(r.recommendations[0], /^SHOPIFY_GHL_CONTACT_ID_METAFIELD=gohighlevel\.contact_id/);
  assert.equal(r.shopifyMetafields['custom.npi'].equalsGhlContactId, 0);
  assert.ok(!JSON.stringify(r).includes('ghl1abc'), 'no ID values in output');
});

test('finds a GHL custom field holding the Shopify customer id (numeric or gid)', () => {
  const s = [
    sample(11, { fields: [{ id: 'fld_shop', value: '11' }] }),
    sample(12, { fields: [{ id: 'fld_shop', value: 'gid://shopify/Customer/12' }] }),
  ];
  const r = analyzeIdentity(s, new Map([['fld_shop', 'Shopify Customer ID']]));
  assert.match(r.recommendations[0], /^GHL_SHOPIFY_CUSTOMER_ID_FIELD_ID=fld_shop \("Shopify Customer ID"\)/);
});

test('email-only integrations get the email-fallback recommendation; shared emails are flagged', () => {
  const r = analyzeIdentity([sample(21), sample(22, { ghlMatches: 2 }), sample(23, { ghlMatches: 0 })]);
  assert.match(r.recommendations[0], /email only/);
  assert.match(r.recommendations[1], /1 sampled providers share an email/);
  assert.deepEqual(r.email, { uniqueGhlContact: 1, noGhlContact: 1, multipleGhlContacts: 1 });
});

test('missing configuration names the environment variables to set', () => {
  const cfg = loadConfig({ DATABASE_URL: 'x', SHOPIFY_SHOP: 's' });
  assert.throws(() => requireKeys(cfg, ['databaseUrl', 'shopify.clientSecret', 'ghl.token', 'ghl.locationId']),
    /Missing environment variables: SHOPIFY_API_SECRET, GHL_PRIVATE_INTEGRATION_TOKEN, GHL_LOCATION_ID/);
});
