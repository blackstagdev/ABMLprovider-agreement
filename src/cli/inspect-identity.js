// npm run inspect:identity [-- --sample 50]
// READ-ONLY. Samples provider customers (PROVIDER_TAGS) in Shopify, finds each one's GHL contact by
// email, and reports where the existing registration workflow stores cross-platform IDs.
// Prints field names and counts only: no emails, names or ID values.
import { loadConfig, requireKeys } from '../config.js';
import { analyzeIdentity } from '../domain/identity-inspect.js';
import { normalizeEmail } from '../domain/identity.js';
import { createGhlClient } from '../ghl/client.js';
import { createShopifyAdmin } from '../shopify/admin.js';

const args = process.argv.slice(2);
const i = args.indexOf('--sample');
const sample = Math.min(250, i >= 0 ? Number(args[i + 1]) : 50);

const cfg = loadConfig();
requireKeys(cfg, ['shopify.shop', 'shopify.clientSecret', 'ghl.token', 'ghl.locationId']);
const admin = createShopifyAdmin({ ...cfg.shopify, db: null });
const ghl = createGhlClient({ token: cfg.ghl.token, locationId: cfg.ghl.locationId, requestsPerSecond: cfg.ghl.requestsPerSecond });

const tagQuery = cfg.shopify.providerTags.map((t) => `tag:'${t}'`).join(' OR ');
const d = await admin.graphql(
  `query($n: Int!, $q: String!) { customers(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) {
     nodes { id email note metafields(first: 50) { nodes { namespace key value } } } } }`,
  { n: sample, q: tagQuery },
);

const samples = [];
for (const c of d.customers.nodes) {
  const email = normalizeEmail(c.email);
  const matches = email ? (await ghl.searchContactsByEmail(email)).filter((x) => normalizeEmail(x.email) === email) : [];
  const ghlContact = matches.length === 1 ? await ghl.getContact(matches[0].id).catch(() => null) : null;
  samples.push({ customer: { id: c.id, note: c.note, metafields: c.metafields.nodes }, ghlContact, ghlMatches: matches.length });
}

const fieldNames = new Map();
try {
  const r = await fetch(`https://services.leadconnectorhq.com/locations/${cfg.ghl.locationId}/customFields`, {
    headers: { Authorization: `Bearer ${cfg.ghl.token}`, Version: '2021-07-28', Accept: 'application/json' },
  });
  if (r.ok) for (const f of (await r.json()).customFields ?? []) fieldNames.set(f.id, f.name);
} catch {
  /* names are optional */
}

console.log(JSON.stringify(analyzeIdentity(samples, fieldNames), null, 2));
