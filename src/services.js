// Wires config -> clients -> sync. Shared by the server and CLIs.
import { loadConfig, requireKeys } from './config.js';
import { createPgDb } from './db.js';
import { createGhlClient } from './ghl/client.js';
import { createGhlService } from './ghl/service.js';
import { createShopifyAdmin } from './shopify/admin.js';
import { createShopifyCustomers } from './shopify/customers.js';
import { createJobs } from './sync/jobs.js';
import { createReconciler } from './sync/reconcile.js';
import { createSignatureSync } from './sync/signature-sync.js';

export async function buildServices({ cfg = loadConfig(), db = null } = {}) {
  requireKeys(cfg, ['databaseUrl', 'shopify.shop', 'shopify.clientSecret', 'ghl.token', 'ghl.locationId']);
  if (!cfg.shopify.staticAccessToken) requireKeys(cfg, ['shopify.clientId']);
  db ??= createPgDb(cfg.databaseUrl);
  return wireServices({ cfg, db });
}

export function wireServices({ cfg, db, ghlClient, shopifyAdmin }) {
  ghlClient ??= createGhlClient({ token: cfg.ghl.token, locationId: cfg.ghl.locationId, requestsPerSecond: cfg.ghl.requestsPerSecond });
  shopifyAdmin ??= createShopifyAdmin({ ...cfg.shopify, db });
  const ghl = createGhlService(ghlClient, cfg.ghl);
  const shopify = createShopifyCustomers(shopifyAdmin, cfg.shopify);
  const jobs = createJobs(db);
  const sync = createSignatureSync({ db, ghl, shopify, cfg, enqueue: jobs.enqueue });
  const reconciler = createReconciler({ db, ghl, shopify, sync, cfg });
  const handlers = {
    verify_contact: (p) => sync.syncContact(p.contactId, { source: p.source, documentId: p.documentId }),
    init_customer: (p) => sync.initCustomer(p.customerId),
    cleanup_tag: (p) => sync.cleanupTag(p.customerId),
    reconcile: () => reconciler.run(),
    reconcile_deep: async () => {
      const r = await reconciler.run({ deep: true });
      if (r.skipped) throw new Error('reconcile already running; deep scan will retry'); // don't count as the daily run
      return r;
    },
  };
  return { cfg, db, ghl, shopify, jobs, sync, reconciler, handlers, shopifyAdmin };
}
