// SQL for durable sync state. Every function takes a `q` ({query}) so it can run inside a transaction.
import { normalizeEmail } from '../domain/identity.js';

export const repo = {
  async loadMappings(q, ids) {
    const map = new Map();
    if (!ids.length) return map;
    const r = await q.query('SELECT document_id, is_agreement, source FROM document_mappings WHERE document_id = ANY($1)', [ids]);
    for (const row of r.rows) map.set(row.document_id, row);
    return map;
  },

  async upsertMapping(q, { documentId, isAgreement, source, note = null }) {
    // A reviewed import may override anything; a workflow event never overrides a reviewed rejection.
    await q.query(
      `INSERT INTO document_mappings (document_id, is_agreement, source, note) VALUES ($1,$2,$3,$4)
       ON CONFLICT (document_id) DO UPDATE SET is_agreement = EXCLUDED.is_agreement, source = EXCLUDED.source,
         note = EXCLUDED.note, updated_at = now()
       WHERE EXCLUDED.source = 'reviewed_import' OR document_mappings.source <> 'reviewed_import'`,
      [documentId, isAgreement, source, note],
    );
  },

  /** Keeps the earliest verified signature for a contact; never downgraded. Returns true if newly stored. */
  async recordSignature(q, s) {
    const r = await q.query(
      `INSERT INTO verified_signatures (ghl_contact_id, document_id, recipient_id, email_normalized, signed_at, verified_via)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (ghl_contact_id) DO UPDATE SET
         document_id = CASE WHEN EXCLUDED.signed_at < verified_signatures.signed_at THEN EXCLUDED.document_id ELSE verified_signatures.document_id END,
         recipient_id = CASE WHEN EXCLUDED.signed_at < verified_signatures.signed_at THEN EXCLUDED.recipient_id ELSE verified_signatures.recipient_id END,
         signed_at = LEAST(verified_signatures.signed_at, EXCLUDED.signed_at),
         email_normalized = COALESCE(verified_signatures.email_normalized, EXCLUDED.email_normalized),
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [s.contactId, s.documentId, s.recipientId, normalizeEmail(s.email), s.signedAt, s.via],
    );
    return r.rows[0]?.inserted === true;
  },

  async signatureByContact(q, contactId) {
    return (await q.query('SELECT * FROM verified_signatures WHERE ghl_contact_id = $1', [contactId])).rows[0] ?? null;
  },
  async signaturesByEmail(q, email) {
    const norm = normalizeEmail(email);
    if (!norm) return [];
    return (await q.query('SELECT * FROM verified_signatures WHERE email_normalized = $1', [norm])).rows;
  },
  async unappliedSignatures(q, limit = 500) {
    return (await q.query('SELECT * FROM verified_signatures WHERE applied_at IS NULL ORDER BY created_at LIMIT $1', [limit])).rows;
  },
  async markApplied(q, contactId, customerId) {
    await q.query('UPDATE verified_signatures SET applied_at = now(), shopify_customer_id = $2, updated_at = now() WHERE ghl_contact_id = $1', [contactId, customerId]);
  },

  async linkByCustomer(q, customerId) {
    return (await q.query('SELECT * FROM customer_links WHERE shopify_customer_id = $1', [customerId])).rows[0] ?? null;
  },
  async linkByContact(q, contactId) {
    return (await q.query('SELECT * FROM customer_links WHERE ghl_contact_id = $1', [contactId])).rows[0] ?? null;
  },
  async saveLink(q, customerId, contactId, method) {
    await q.query(
      `INSERT INTO customer_links (shopify_customer_id, ghl_contact_id, method) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [customerId, contactId, method],
    );
  },

  async state(q, customerId) {
    return (await q.query('SELECT * FROM customer_state WHERE shopify_customer_id = $1', [customerId])).rows[0] ?? null;
  },
  async markSignedConfirmed(q, customerId, tagCleanupNeeded) {
    await q.query(
      `INSERT INTO customer_state (shopify_customer_id, signed_confirmed_at, tag_cleanup_needed) VALUES ($1, now(), $2)
       ON CONFLICT (shopify_customer_id) DO UPDATE SET
         signed_confirmed_at = COALESCE(customer_state.signed_confirmed_at, now()),
         tag_cleanup_needed = EXCLUDED.tag_cleanup_needed, updated_at = now()`,
      [customerId, tagCleanupNeeded],
    );
  },
  async markInitialized(q, customerId) {
    await q.query(
      `INSERT INTO customer_state (shopify_customer_id, initialized_at) VALUES ($1, now())
       ON CONFLICT (shopify_customer_id) DO UPDATE SET initialized_at = COALESCE(customer_state.initialized_at, now()), updated_at = now()`,
      [customerId],
    );
  },
  async customersNeedingTagCleanup(q) {
    return (await q.query('SELECT shopify_customer_id FROM customer_state WHERE tag_cleanup_needed AND signed_confirmed_at IS NOT NULL')).rows.map((r) => r.shopify_customer_id);
  },
};
