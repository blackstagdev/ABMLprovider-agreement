// Periodic reconciliation: catches missed workflow events, signatures recorded before the
// Shopify customer existed, and pending tags left behind by partial writes.
import { lockKey } from '../db.js';
import { log } from '../log.js';
import { repo } from './repo.js';

export function createReconciler({ db, ghl, shopify, sync, cfg }) {
  /** Record verified signatures from documents in the last `days` (default: light window). */
  async function scanRecent(days = cfg.ghl.recentLookbackDays) {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400_000);
    let recorded = 0;
    for await (const page of ghl.pages({ dateFrom: from.toISOString(), dateTo: to.toISOString(), pageSize: cfg.ghl.pageSize })) {
      for (const ev of await sync.evaluateDocs(db, page.documents)) {
        for (const s of ev.signers) if (s.outcome === 'signed' && (await repo.recordSignature(db, s))) recorded++;
      }
    }
    return recorded;
  }

  async function applyPending() {
    const counts = { applied: 0, waiting: 0 };
    for (const sig of await repo.unappliedSignatures(db)) {
      const m = await sync.matchSigner({ contactId: sig.ghl_contact_id, email: sig.email_normalized });
      if (m.status === 'matched') {
        await sync.applySigned(m.customer.id, sig.ghl_contact_id);
        counts.applied++;
      } else counts.waiting++;
    }
    return counts;
  }

  async function cleanupTags() {
    let cleaned = 0;
    const ids = new Set(await repo.customersNeedingTagCleanup(db));
    for await (const c of shopify.allCustomers(`tag:'${cfg.shopify.pendingTag}'`)) if (c.signed === true) ids.add(c.id);
    for (const id of ids) {
      await sync.cleanupTag(id);
      cleaned++;
    }
    return cleaned;
  }

  /** Single-flight across instances via a session-level advisory lock held in a transaction. */
  async function run({ deep = false } = {}) {
    return db.tx(async (q) => {
      const got = (await q.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [lockKey('reconcile')])).rows[0]?.ok;
      if (!got) return { skipped: true };
      const days = deep ? cfg.ghl.deepLookbackDays : cfg.ghl.recentLookbackDays;
      const recorded = await scanRecent(days);
      const pending = await applyPending();
      const cleaned = await cleanupTags();
      const result = { deep, days, recorded, ...pending, cleaned };
      log.info('reconcile complete', result);
      return result;
    });
  }

  return { run, scanRecent, applyPending, cleanupTags };
}
