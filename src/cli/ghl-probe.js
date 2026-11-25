// npm run ghl:probe
// READ-ONLY diagnostic for GHL API access. Each request varies one thing, so the first one that fails
// shows what GHL rejects. Prints HTTP status, GHL's reason (emails masked) and document totals only.
import { loadConfig, requireKeys } from '../config.js';
import { createGhlClient } from '../ghl/client.js';

const cfg = loadConfig();
requireKeys(cfg, ['ghl.token', 'ghl.locationId']);
const ghl = createGhlClient({ token: cfg.ghl.token, locationId: cfg.ghl.locationId, requestsPerSecond: 4 });

const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * 86400_000);
const iso = (d) => d.toISOString();
const isoNoMs = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const probes = [
  ['location only (no paging params)', {}],
  ['limit=10 skip=0', { limit: 10, skip: 0 }],
  ['limit=20', { limit: 20, skip: 0 }],
  ['limit=50', { limit: 50, skip: 0 }],
  ['limit=100 (app default)', { limit: 100, skip: 0 }],
  ['dates: last 7 days, limit=10', { limit: 10, skip: 0, dateFrom: iso(daysAgo(7)), dateTo: iso(now) }],
  [`dates: last ${cfg.ghl.recentLookbackDays} days, limit=10 (reconcile window)`, { limit: 10, skip: 0, dateFrom: iso(daysAgo(cfg.ghl.recentLookbackDays)), dateTo: iso(now) }],
  ['dates without milliseconds, last 7 days', { limit: 10, skip: 0, dateFrom: isoNoMs(daysAgo(7)), dateTo: isoNoMs(now) }],
  ['dates as YYYY-MM-DD, last 7 days', { limit: 10, skip: 0, dateFrom: iso(daysAgo(7)).slice(0, 10), dateTo: iso(now).slice(0, 10) }],
  ['status=completed limit=10', { limit: 10, skip: 0, status: 'completed' }],
  ['query search, limit=10', { limit: 10, skip: 0, query: 'Provider Agreement' }],
];

console.log(`GHL probe: location ${cfg.ghl.locationId.slice(0, 4)}…, page size setting ${cfg.ghl.pageSize}\n`);
let firstDoc = null;
for (const [label, params] of probes) {
  try {
    const r = await ghl.listDocuments(params);
    const docs = r?.documents ?? [];
    firstDoc ??= docs[0] ?? null;
    console.log(`OK   ${label}: returned ${docs.length}, total ${r?.total ?? '?'}`);
  } catch (e) {
    console.log(`FAIL ${label}: HTTP ${e.status ?? '?'} ${e.ghlReason || e.message}`);
  }
}

if (firstDoc) {
  // Shape check for the open questions in CLAUDE.md (field names only, no values).
  const r0 = firstDoc.recipients?.[0] ?? {};
  console.log('\nDocument fields:', Object.keys(firstDoc).sort().join(', '));
  console.log('Has template id field:', ['templateId', 'template_id', 'template'].filter((k) => k in firstDoc).join(', ') || 'none');
  console.log('Recipient fields:', Object.keys(r0).sort().join(', '));
}
