// npm run export:unsigned                 -> reports/provider-agreement-status-<date>.xlsx
// npm run export:unsigned -- --run 4      -> use a specific backfill run for the GHL history
// READ-ONLY (Shopify, GHL and the database). The workbook contains customer names and emails:
// it is written under reports/ (git-ignored). The console prints counts only.
import { mkdir } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { loadConfig, requireKeys } from '../config.js';
import { createPgDb } from '../db.js';
import { normalizeEmail } from '../domain/identity.js';
import { createGhlClient } from '../ghl/client.js';
import { buildExport, latestRun, loadDbFacts, STATUS } from '../report/unsigned-export.js';
import { createShopifyAdmin } from '../shopify/admin.js';

const args = process.argv.slice(2);
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;
const cfg = loadConfig();
requireKeys(cfg, ['databaseUrl', 'shopify.shop', 'shopify.clientSecret', 'ghl.token', 'ghl.locationId']);
const db = createPgDb(cfg.databaseUrl);
const admin = createShopifyAdmin({ ...cfg.shopify, db });
const ghl = createGhlClient({ token: cfg.ghl.token, locationId: cfg.ghl.locationId, requestsPerSecond: cfg.ghl.requestsPerSecond });
const sm = cfg.shopify.signedMetafield;
const storeHandle = cfg.shopify.shop.replace(/\.myshopify\.com$/, '');
const urls = {
  shopifyCustomer: (id) => (id ? `https://admin.shopify.com/store/${storeHandle}/customers/${id}` : ''),
  ghlContact: (id) => (id ? `https://app.gohighlevel.com/v2/location/${cfg.ghl.locationId}/contacts/detail/${id}` : ''),
};
const err = (s) => process.stderr.write(s);

async function allCustomers() {
  const out = [];
  let after = null;
  for (;;) {
    const d = await admin.graphql(
      `query($after: String) { customers(first: 100, after: $after) {
         nodes { id legacyResourceId firstName lastName email tags state createdAt numberOfOrders
           amountSpent { amount currencyCode } lastOrder { createdAt }
           defaultAddress { company city provinceCode countryCodeV2 }
           signed: metafield(namespace: "${sm.namespace}", key: "${sm.key}") { value } }
         pageInfo { hasNextPage endCursor } } }`,
      { after },
    );
    for (const n of d.customers.nodes) {
      out.push({
        id: n.id,
        legacyId: n.legacyResourceId,
        firstName: n.firstName,
        lastName: n.lastName,
        email: n.email,
        tags: n.tags ?? [],
        state: n.state,
        createdAt: n.createdAt,
        orders: Number(n.numberOfOrders ?? 0),
        amountSpent: Number(n.amountSpent?.amount ?? 0),
        currency: n.amountSpent?.currencyCode ?? '',
        lastOrderAt: n.lastOrder?.createdAt ?? null,
        company: n.defaultAddress?.company ?? '',
        city: n.defaultAddress?.city ?? '',
        province: n.defaultAddress?.provinceCode ?? '',
        country: n.defaultAddress?.countryCodeV2 ?? '',
        signed: n.signed?.value === 'true' ? true : n.signed?.value === 'false' ? false : null,
      });
    }
    err(`\rShopify customers read: ${out.length}`);
    if (!d.customers.pageInfo.hasNextPage) break;
    after = d.customers.pageInfo.endCursor;
  }
  err('\n');
  return out;
}

const contactCache = new Map();
async function getContact(id) {
  if (!contactCache.has(id)) {
    let c = null;
    try {
      c = await ghl.getContact(id);
    } catch (e) {
      if (!(e.status === 404 || (e.status === 400 && /not found/i.test(e.ghlReason ?? e.message)))) throw e;
    }
    contactCache.set(id, c);
  }
  return contactCache.get(id);
}
async function lookupContacts(customer) {
  const e = normalizeEmail(customer.email);
  if (!e) return [];
  return (await ghl.searchContactsByEmail(e)).filter((c) => normalizeEmail(c.email) === e);
}

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([key, header, width]) => ({ key, header, width }));
  for (const r of rows) {
    const row = ws.addRow(r);
    for (const [key] of columns.filter(([k]) => /Link$/.test(k))) {
      if (r[key]) row.getCell(key).value = { text: 'Open', hyperlink: r[key] };
    }
  }
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2861A9' } };
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

const CUSTOMER_COLS = [
  ['name', 'Customer name', 24],
  ['email', 'Shopify email', 32],
  ['company', 'Company', 24],
  ['location', 'Location', 20],
  ['tags', 'Shopify tags', 24],
  ['accountState', 'Account state', 14],
  ['orders', 'Orders', 9],
  ['amountSpent', 'Amount spent', 13],
  ['currency', 'Currency', 9],
  ['lastOrderAt', 'Last order', 12],
  ['createdAt', 'Customer since', 14],
  ['shopifyCustomerId', 'Shopify customer ID', 18],
  ['shopifyLink', 'Shopify admin', 13],
];

try {
  const run = runArg ? { id: runArg } : await latestRun(db);
  if (!run) throw new Error('No completed backfill run found');
  const facts = await loadDbFacts(db, run.id);
  const customers = await allCustomers();
  const result = await buildExport({
    customers,
    facts,
    providerTags: cfg.shopify.providerTags,
    lookupContacts,
    getContact,
    links: urls,
    onProgress: (n, total) => err(`\rProviders checked in GHL: ${n}/${total}`),
  });
  err('\n');
  const { counts, byStatus } = result;

  const wb = new ExcelJS.Workbook();
  const today = new Date().toISOString().slice(0, 10);
  const summary = [
    ['Generated', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
    ['Backfill run used for GHL history', String(run.id)],
    ['Provider tag(s)', cfg.shopify.providerTags.join(', ')],
    [],
    ['Shopify customers (all)', counts.customers],
    ['Customers with Provider agreement signed = true', counts.signedTrue],
    ['  of which tagged as provider', counts.providerTrue],
    ['  of which NOT tagged as provider', counts.signedNotProvider],
    [`Shopify customers written true by backfill run ${run.id}`, facts.written],
    [],
    ['Provider customers (tagged)', counts.providers],
    ['  signed = true', counts.providerTrue],
    ['  NOT filled (false or not set)', counts.providerFalse + counts.providerMissing],
    ['    value false', counts.providerFalse],
    ['    value not set', counts.providerMissing],
    [],
    ['Not-filled providers by status', ''],
    ...Object.entries(STATUS).map(([k, label]) => [`  ${label}`, byStatus[k]]),
    [],
    ['Signed in GHL but could not be written (review sheet rows)', result.review.length],
  ];
  const ws = wb.addWorksheet('Summary');
  ws.columns = [{ width: 62 }, { width: 24 }];
  for (const r of summary) ws.addRow(r);
  ws.getColumn(1).font = { bold: false };
  for (const n of [5, 11, 17]) ws.getRow(n).font = { bold: true };

  addSheet(
    wb,
    'Providers not filled',
    [
      ['status', 'Status', 38],
      ['action', 'Suggested action', 60],
      ...CUSTOMER_COLS,
      ['metafield', 'Metafield value', 14],
      ['ghlContacts', 'GHL contacts with email', 12],
      ['ghlContactId', 'GHL contact ID', 26],
      ['ghlName', 'GHL name', 24],
      ['ghlEmail', 'GHL email', 32],
      ['ghlPhone', 'GHL phone', 16],
      ['ghlTags', 'GHL tags', 30],
      ['ghlAdded', 'GHL contact added', 14],
      ['invitations', 'Agreements sent (unsigned)', 12],
      ['lastDocumentId', 'Latest agreement document ID', 28],
      ['backfillOutcome', 'Backfill outcome', 16],
      ['backfillReason', 'Backfill reason', 28],
      ['signedAt', 'Signed in GHL on', 14],
      ['ghlLink', 'GHL contact', 12],
    ],
    result.notFilled,
  );
  addSheet(
    wb,
    'Signed - needs review',
    [
      ['outcome', 'Outcome', 12],
      ['reason', 'Reason', 30],
      ['explanation', 'What to do', 70],
      ['ghlContactId', 'GHL contact ID', 26],
      ['ghlName', 'GHL name', 24],
      ['ghlEmail', 'GHL email', 32],
      ['shopifyCustomers', 'Shopify customers with this email <ID>', 40],
      ['documentId', 'Signed document ID', 28],
      ['ghlLink', 'GHL contact', 12],
    ],
    result.review,
  );
  addSheet(wb, 'Signed - not provider tag', CUSTOMER_COLS, result.filledNotProvider);

  await mkdir('reports', { recursive: true });
  const file = `reports/provider-agreement-status-${today}.xlsx`;
  await wb.xlsx.writeFile(file);
  console.log(JSON.stringify({ file, runId: String(run.id), counts, notFilledByStatus: byStatus, reviewRows: result.review.length }, null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
