// Test harness: real Postgres (PGlite) with real migrations, plus in-memory GHL and Shopify fakes.
// All fixture data is synthetic.
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../src/config.js';
import { wrapPglite } from '../src/db.js';
import { createGhlService } from '../src/ghl/service.js';
import { migrate } from '../src/migrate.js';
import { createSignatureSync } from '../src/sync/signature-sync.js';
import { createJobs } from '../src/sync/jobs.js';
import { createReconciler } from '../src/sync/reconcile.js';

process.env.LOG_SILENT = '1';

export async function newDb() {
  const pg = new PGlite();
  const db = wrapPglite(pg);
  await migrate(db, (sql) => pg.exec(sql));
  return db;
}

export function testConfig(overrides = {}) {
  const cfg = loadConfig({
    DATABASE_URL: 'postgres://test',
    SHOPIFY_SHOP: 'test-shop.myshopify.com',
    SHOPIFY_API_KEY: 'key',
    SHOPIFY_API_SECRET: 'shpss_test_secret',
    GHL_PRIVATE_INTEGRATION_TOKEN: 'pit-test',
    GHL_LOCATION_ID: 'loc_1',
    GHL_WEBHOOK_SECRET: 'whsec_test',
    STATUS_RECHECK_SECONDS: '0',
    BACKFILL_START_DATE: '2024-01-01T00:00:00Z',
    BACKFILL_WINDOW_DAYS: '90',
    BACKFILL_PAGE_SIZE: '2',
    ...overrides,
  });
  return cfg;
}

// ---------- GHL fake (client-level, mirrors documented /proposals/document response) ----------
export function fakeGhlClient() {
  const docs = [];
  const contacts = new Map();
  const calls = { listDocuments: 0, addContactTags: [] };
  let failNextList = 0;
  return {
    docs,
    contacts,
    calls,
    failListTimes(n) {
      failNextList = n;
    },
    async listDocuments({ limit = 100, skip = 0, query, dateFrom, dateTo, status } = {}) {
      calls.listDocuments++;
      if (failNextList > 0) {
        failNextList--;
        throw Object.assign(new Error('GHL 503'), { status: 503 });
      }
      let list = docs.filter((d) => !d._hidden);
      if (query) {
        const q = query.toLowerCase();
        list = list.filter((d) => d.name.toLowerCase().includes(q) || d.recipients.some((r) => (r.email || '').toLowerCase() === q));
      }
      if (dateFrom && dateTo) list = list.filter((d) => d.createdAt >= dateFrom && d.createdAt < dateTo);
      if (status) list = list.filter((d) => status.split(',').includes(d.status));
      return { documents: list.slice(skip, skip + limit), total: list.length };
    },
    async getContact(id) {
      const c = contacts.get(id);
      if (!c) throw Object.assign(new Error('404'), { status: 404 });
      return c;
    },
    async searchContactsByEmail(email) {
      return [...contacts.values()].filter((c) => (c.email || '').toLowerCase() === email);
    },
    async addContactTags(id, tags) {
      calls.addContactTags.push({ id, tags });
      return { tags };
    },
  };
}

let seq = 0;
export function makeDoc({ id, contactId, email, name = 'Alpha BioMed Provider Agreement', hasCompleted = false, signedDate, status, createdAt = '2025-03-01T00:00:00.000Z', isExpired = false, role = 'signer', extraRecipients = [], templateId, shareLink }) {
  const docId = id ?? `doc_${++seq}`;
  return {
    _id: docId,
    documentId: docId,
    locationId: 'loc_1',
    name,
    type: 'proposal',
    deleted: false,
    isExpired,
    status: status ?? (hasCompleted ? 'completed' : 'sent'),
    paymentStatus: 'no_payment',
    createdAt,
    updatedAt: signedDate ?? createdAt,
    ...(templateId ? { templateId } : {}),
    recipients: [
      {
        id: contactId,
        email,
        firstName: 'Test',
        lastName: 'Provider',
        role,
        hasCompleted,
        isPrimary: true,
        signingOrder: 1,
        ...(signedDate ? { signedDate } : {}),
        shareLink: shareLink ?? `https://link.example.test/sign/${docId}/${contactId}`,
      },
      ...extraRecipients,
    ],
    links: [
      { referenceId: contactId, documentId: docId, recipientId: contactId, entityName: 'contacts', recipientCategory: 'recipient', deleted: false },
      ...extraRecipients.map((r) => ({ referenceId: r.id, documentId: docId, recipientId: r.id, entityName: r._entity ?? 'users', recipientCategory: r._category ?? 'recipient', deleted: false })),
    ],
  };
}

// ---------- Shopify fake (customer-service level) ----------
export function fakeShopify() {
  const customers = new Map();
  const writes = [];
  const fail = { removeTag: 0, setSigned: 0 };
  const clone = (c) => c && JSON.parse(JSON.stringify(c));
  return {
    customers,
    writes,
    fail,
    add(c) {
      const full = { firstName: 'Test', lastName: 'Provider', tags: [], signed: null, ghlContactId: null, ...c };
      customers.set(full.id, full);
      return full;
    },
    async getCustomer(id) {
      return clone(customers.get(id) ?? null);
    },
    async findByEmail(email) {
      const e = email.toLowerCase();
      return [...customers.values()].filter((c) => (c.email || '').toLowerCase() === e).map(clone);
    },
    async *allCustomers(query) {
      for (const c of customers.values()) {
        if (query && query.startsWith('tag:')) {
          const tag = query.slice(4).replace(/'/g, '');
          if (!c.tags.includes(tag)) continue;
        }
        yield clone(c);
      }
    },
    async setSigned(id) {
      if (fail.setSigned > 0) {
        fail.setSigned--;
        throw new Error('metafieldsSet transient failure');
      }
      writes.push({ op: 'setSigned', id });
      customers.get(id).signed = true;
      return clone(customers.get(id));
    },
    async initUnsigned(id) {
      const c = customers.get(id);
      if (c.signed !== null) return 'exists'; // compareDigest:null semantics
      writes.push({ op: 'initUnsigned', id });
      c.signed = false;
      return 'created';
    },
    async addTag(id, tag) {
      writes.push({ op: 'addTag', id, tag });
      const c = customers.get(id);
      if (!c.tags.includes(tag)) c.tags.push(tag);
    },
    async removeTag(id, tag) {
      if (fail.removeTag > 0) {
        fail.removeTag--;
        throw new Error('tagsRemove transient failure');
      }
      writes.push({ op: 'removeTag', id, tag });
      const c = customers.get(id);
      c.tags = c.tags.filter((t) => t !== tag);
    },
  };
}

export async function setup(cfgOverrides = {}) {
  const db = await newDb();
  const cfg = testConfig(cfgOverrides);
  const ghlClient = fakeGhlClient();
  const ghl = createGhlService(ghlClient, cfg.ghl);
  const shopify = fakeShopify();
  const jobs = createJobs(db);
  const sync = createSignatureSync({ db, ghl, shopify, cfg, enqueue: jobs.enqueue });
  const reconciler = createReconciler({ db, ghl, shopify, sync, cfg });
  const handlers = {
    verify_contact: (p) => sync.syncContact(p.contactId, { source: p.source, documentId: p.documentId }),
    init_customer: (p) => sync.initCustomer(p.customerId),
    cleanup_tag: (p) => sync.cleanupTag(p.customerId),
  };
  return { db, cfg, ghlClient, ghl, shopify, jobs, sync, reconciler, handlers };
}

export const gid = (n) => `gid://shopify/Customer/${n}`;
