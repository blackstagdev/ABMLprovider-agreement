// npm run ghl:probe
// READ-ONLY diagnostic for GHL API access. Each request varies one thing, so the first one that fails
// shows what GHL rejects. Prints HTTP status, GHL's reason (emails masked) and document totals only.
import { loadConfig, requireKeys } from '../config.js';
import { createGhlClient } from '../ghl/client.js';
import { normalizeName, providerSigners } from '../domain/agreement.js';

const cfg = loadConfig();
requireKeys(cfg, ['ghl.token', 'ghl.locationId']);
const ghl = createGhlClient({ token: cfg.ghl.token, locationId: cfg.ghl.locationId, requestsPerSecond: 4 });

const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * 86400_000);
const iso = (d) => d.toISOString();
const isoNoMs = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const probes = [
  ['limit=20 (app default, GHL maximum)', { limit: 20, skip: 0 }],
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

// ---- Agreement documents: what a real signature and an open invitation look like ----
// Counts and field names only. Scans up to 10 pages (200 docs) per status.
const target = normalizeName(cfg.ghl.agreementName);
async function sampleAgreements(status, pages = 10) {
  const out = [];
  for (let p = 0; p < pages; p++) {
    let r;
    try {
      r = await ghl.listDocuments({ status, limit: 20, skip: p * 20, query: cfg.ghl.agreementName });
    } catch (e) {
      console.log(`FAIL sampling ${status}: HTTP ${e.status ?? '?'} ${e.ghlReason || e.message}`);
      break;
    }
    const docs = r?.documents ?? [];
    out.push(...docs.filter((d) => normalizeName(d.name) === target));
    if (docs.length < 20) break;
  }
  return out;
}
const keysOf = (objs) => [...new Set(objs.flatMap((o) => Object.keys(o ?? {})))].sort().join(', ');

for (const status of ['completed', 'sent,viewed']) {
  const docs = await sampleAgreements(status);
  const signers = docs.flatMap((d) => providerSigners(d));
  const rawSigners = docs.flatMap((d) => (d.recipients ?? []).filter((r) => r.role === 'signer'));
  const done = signers.filter((s) => s.hasCompleted);
  console.log(`
[${status}] exact-name "${cfg.ghl.agreementName}" documents sampled: ${docs.length}`);
  if (!docs.length) continue;
  console.log(`  contact signers: ${signers.length}, completed: ${done.length}, with signedDate: ${done.filter((s) => s.signedDate).length}`);
  console.log(`  signer recipients with shareLink: ${rawSigners.filter((r) => r.shareLink).length}/${rawSigners.length}`);
  console.log(`  signer recipient fields (union): ${keysOf(rawSigners)}`);
  console.log(`  recipient roles: ${[...new Set(docs.flatMap((d) => (d.recipients ?? []).map((r) => r.role)))].join(', ')}`);
  console.log(`  links fields: ${keysOf(docs.flatMap((d) => d.links ?? []))}`);
  console.log(`  links entityName/category: ${[...new Set(docs.flatMap((d) => (d.links ?? []).map((l) => `${l.entityName}/${l.recipientCategory}`)))].join(', ')}`);
  console.log(`  recipient id equals a links referenceId: ${rawSigners.filter((r) => docs.some((d) => (d.links ?? []).some((l) => l.referenceId === r.id))).length}/${rawSigners.length}`);
  console.log(`  expired: ${docs.filter((d) => d.isExpired).length}, statuses: ${[...new Set(docs.map((d) => d.status))].join(', ')}`);
}

// ---- Which field is the GHL contact id? (counts only) ----
{
  const { normalizeEmail } = await import('../domain/identity.js');
  const r = await ghl.listDocuments({ status: 'completed', limit: 20, skip: 0, query: cfg.ghl.agreementName });
  const docs = (r?.documents ?? []).filter((d) => normalizeName(d.name) === target).slice(0, 8);
  const tally = { checked: 0, linkRecipientIdMatches: 0, idIsContact: 0, idContactEmailMatches: 0, referenceIdIsContact: 0 };
  for (const d of docs) {
    const rec = (d.recipients ?? []).find((x) => x.role === 'signer');
    if (!rec) continue;
    tally.checked++;
    const link = (d.links ?? []).find((l) => l.recipientId === rec.id);
    if (link) tally.linkRecipientIdMatches++;
    const byId = await ghl.getContact(rec.id).catch(() => null);
    if (byId) {
      tally.idIsContact++;
      if (normalizeEmail(byId.email) && normalizeEmail(byId.email) === normalizeEmail(rec.email)) tally.idContactEmailMatches++;
    }
    const refId = link?.referenceId ?? (d.links ?? [])[0]?.referenceId;
    if (refId && (await ghl.getContact(refId).catch(() => null))) tally.referenceIdIsContact++;
  }
  console.log('\n[contact id check on completed agreements]');
  console.log(`  signers checked: ${tally.checked}`);
  console.log(`  links[].recipientId == recipient.id: ${tally.linkRecipientIdMatches}`);
  console.log(`  recipient.id is a GHL contact: ${tally.idIsContact} (same email: ${tally.idContactEmailMatches})`);
  console.log(`  links[].referenceId is a GHL contact: ${tally.referenceIdIsContact}`);
}
