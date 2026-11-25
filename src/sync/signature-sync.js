// Signature sync: verify against GHL, match identity, and write Shopify state idempotently.
//
// Invariants:
//  - Only a verified signature (agreement identified by template ID or verified mapping, provider
//    signer recipient completed, signed timestamp present) can set the flag to true.
//  - Nothing ever writes `false` over `true`: initialization uses compareDigest:null (create-only),
//    and every path re-checks state after writing.
//  - The pending tag is removed only after `true` has been read back from Shopify.
import { lockKey } from '../db.js';
import { documentId, evaluateSignatures, pickActiveInvitation, normalizeName } from '../domain/agreement.js';
import { isProvider } from '../domain/eligibility.js';
import { matchIdentity, normalizeEmail } from '../domain/identity.js';
import { log } from '../log.js';
import { repo } from './repo.js';

export function createSignatureSync({ db, ghl, shopify, cfg, enqueue = async () => {} }) {
  const agreementCfg = {
    agreementName: cfg.ghl.agreementName,
    agreementTemplateId: cfg.ghl.agreementTemplateId,
    requireSignedDate: cfg.ghl.requireSignedDate,
  };
  const providerTags = cfg.shopify.providerTags;
  const pendingTag = cfg.shopify.pendingTag;

  // Serializes all writes for one customer. Follow-up jobs are enqueued after commit.
  async function withCustomerLock(customerId, fn) {
    const after = [];
    const result = await db.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock($1)', [lockKey(`customer:${customerId}`)]);
      return fn(q, after);
    });
    for (const f of after) await f().catch((err) => log.error('post-commit step failed', { customerId, err }));
    return result;
  }

  /** Evaluate a batch of documents, returning per-signer results with mapping lookups applied. */
  async function evaluateDocs(q, docs) {
    const mappings = await repo.loadMappings(q, docs.map(documentId).filter(Boolean));
    return docs.map((d) => evaluateSignatures(d, agreementCfg, mappings.get(documentId(d))));
  }

  /**
   * Identity match for a signer (shared by backfill, webhook and reconcile).
   * `index` (optional, backfill): { byGhlId: Map<contactId, customer[]>, byEmail: Map<email, customer[]> }
   */
  async function matchSigner(signer, index = null) {
    const contact = await ghl.getContact(signer.contactId);
    // Deleted/merged GHL contact: the signer can't be confirmed, so review it.
    if (!contact) return { status: 'ambiguous', reason: 'ghl_contact_not_found' };
    const emails = [...new Set([normalizeEmail(signer.email), normalizeEmail(contact.email)].filter(Boolean))];
    const emailCandidates = [];
    for (const email of emails) {
      emailCandidates.push({
        email,
        shopify: index ? index.byEmail.get(email) ?? [] : await shopify.findByEmail(email),
        ghlContactIds: (await ghl.contactsWithEmail(email)).map((c) => c.id),
      });
    }
    const link = await repo.linkByContact(db, signer.contactId);
    const shopifyByGhlField = contact.shopifyCustomerId ? await shopify.getCustomer(contact.shopifyCustomerId) : null;
    const allByEmail = emailCandidates.flatMap((c) => c.shopify);
    const shopifyByStoredId = index
      ? index.byGhlId.get(signer.contactId) ?? []
      : allByEmail.filter((c) => c.ghlContactId === signer.contactId);
    return matchIdentity({
      contactId: signer.contactId,
      recipientEmail: signer.email,
      ghlContact: contact,
      shopifyByStoredId,
      shopifyByGhlField,
      shopifyByEmail: allByEmail,
      linkedCustomerId: link?.shopify_customer_id ?? null,
      emailCandidates,
    });
  }

  /** Set true, read back, then remove the pending tag. Caller must hold the customer lock. */
  async function applySignedLocked(q, customerId, after) {
    const before = await shopify.getCustomer(customerId);
    if (!before) throw new Error('Shopify customer not found');
    if (before.signed !== true) await shopify.setSigned(customerId); // reads back true or throws
    await repo.markSignedConfirmed(q, customerId, true);
    try {
      if ((before.tags ?? []).includes(pendingTag)) await shopify.removeTag(customerId, pendingTag);
      await repo.markSignedConfirmed(q, customerId, false);
    } catch (err) {
      // Access is already granted; retry the cleanup separately.
      log.warn('pending tag cleanup deferred', { customerId, err });
      after.push(() => enqueue('cleanup_tag', { customerId }, `cleanup_tag:${customerId}`, { delaySeconds: 30 }));
    }
    return before.signed === true ? 'already_signed' : 'newly_signed';
  }

  const writesEnabled = () => cfg.sync.shopifyWrites === true;

  /** @returns {'newly_signed'|'already_signed'|'deferred'} 'deferred' = writes disabled; the signature stays unapplied. */
  async function applySigned(customerId, contactId, { force = false } = {}) {
    if (!force && !writesEnabled()) return 'deferred';
    return withCustomerLock(customerId, async (q, after) => {
      const result = await applySignedLocked(q, customerId, after);
      if (contactId) {
        await repo.saveLink(q, customerId, contactId, 'signature_match');
        await repo.markApplied(q, contactId, customerId);
      }
      return result;
    });
  }

  /**
   * Fetch this contact's documents from GHL and record any verified signature.
   * source 'workflow_event' = a template-filtered GHL workflow told us this contact completed the
   * agreement; that verifies the document->template link for that contact's completed document.
   */
  async function verifyContact(contactId, { source = 'check', documentId: hintedDocId = null } = {}) {
    const contact = await ghl.getContact(contactId);
    if (!contact) return { signed: false, reason: 'contact_not_found' };
    if (!contact.email) return { signed: false, reason: 'contact_has_no_email' };
    const docs = (await ghl.documentsForEmail(contact.email)).filter((d) =>
      (d.recipients ?? []).some((r) => (r.contactId || r.id) === contactId),
    );

    if (source === 'workflow_event') {
      for (const d of docs) {
        const id = documentId(d);
        if (hintedDocId && id !== hintedDocId) continue;
        const signer = (d.recipients ?? []).find((r) => (r.contactId || r.id) === contactId && r.role === 'signer');
        if (signer?.hasCompleted && normalizeName(d.name) === normalizeName(agreementCfg.agreementName)) {
          await repo.upsertMapping(db, { documentId: id, isAgreement: true, source: 'workflow_event' });
        }
      }
    }

    let best = null;
    for (const ev of await evaluateDocs(db, docs)) {
      for (const s of ev.signers) {
        if (s.contactId !== contactId || s.outcome !== 'signed') continue;
        if (!best || s.signedAt < best.signedAt) best = s;
      }
    }
    if (!best) return { signed: false, reason: 'no_verified_signature' };
    await repo.recordSignature(db, best);
    return { signed: true, signature: best };
  }

  /** Verify a contact, then apply to the matching Shopify customer (or leave pending if none yet). */
  async function syncContact(contactId, opts = {}) {
    const v = await verifyContact(contactId, opts);
    if (!v.signed) return { outcome: 'not_signed', reason: v.reason };
    const m = await matchSigner(v.signature);
    if (m.status !== 'matched') {
      log.info('verified signature awaiting customer', { contactId, status: m.status, reason: m.reason });
      return { outcome: m.status, reason: m.reason };
    }
    const result = await applySigned(m.customer.id, contactId);
    return { outcome: result, customerId: m.customer.id };
  }

  /** Find the GHL contact for a Shopify customer, using the same identity rules in reverse. */
  async function resolveContact(customer) {
    const link = await repo.linkByCustomer(db, customer.id);
    if (link) return { contactId: link.ghl_contact_id };
    if (customer.ghlContactId) return { contactId: customer.ghlContactId };
    // A verified signature recorded before this customer existed.
    const sigs = await repo.signaturesByEmail(db, customer.email);
    for (const s of sigs) {
      const m = await matchSigner({ contactId: s.ghl_contact_id, email: s.email_normalized });
      if (m.status === 'matched' && m.customer.id === customer.id) return { contactId: s.ghl_contact_id };
    }
    // Email fallback: only when exactly one GHL contact has it, and it isn't linked to another customer.
    const email = normalizeEmail(customer.email);
    if (!email) return null;
    const contacts = await ghl.contactsWithEmail(email);
    if (contacts.length !== 1) return null;
    const c = contacts[0];
    if (c.shopifyCustomerId && c.shopifyCustomerId !== customer.id) return null;
    const other = await repo.linkByContact(db, c.id);
    if (other && other.shopify_customer_id !== customer.id) return null;
    return { contactId: c.id };
  }

  /**
   * Initialize a provider: check for an existing signature first, else set false + pending tag.
   * Safe to run late or repeatedly.
   */
  async function initCustomer(customerId) {
    if (!writesEnabled()) return { outcome: 'skipped_writes_disabled' };
    const customer = await shopify.getCustomer(customerId);
    if (!customer) return { outcome: 'not_found' };
    if (!isProvider(customer, providerTags)) return { outcome: 'not_provider' };
    if (customer.signed === true) {
      if (customer.tags.includes(pendingTag)) await applySigned(customerId);
      return { outcome: 'already_signed' };
    }

    const contact = await resolveContact(customer);
    if (contact) {
      let sig = await repo.signatureByContact(db, contact.contactId);
      if (!sig) sig = (await verifyContact(contact.contactId)).signed ? await repo.signatureByContact(db, contact.contactId) : null;
      if (sig) {
        const m = await matchSigner({ contactId: sig.ghl_contact_id, email: sig.email_normalized });
        if (m.status === 'matched' && m.customer.id === customerId) {
          return { outcome: await applySigned(customerId, contact.contactId) };
        }
      }
    }

    return withCustomerLock(customerId, async (q, after) => {
      const st = await repo.state(q, customerId);
      if (st?.signed_confirmed_at) return { outcome: await applySignedLocked(q, customerId, after) };
      const created = await shopify.initUnsigned(customerId);
      if (!customer.tags.includes(pendingTag)) await shopify.addTag(customerId, pendingTag);
      await repo.markInitialized(q, customerId);
      // Re-check: a signature may have landed while we were initializing.
      const latest = await shopify.getCustomer(customerId);
      if (latest?.signed === true) {
        await applySignedLocked(q, customerId, after);
        return { outcome: 'already_signed' };
      }
      return { outcome: created === 'created' ? 'initialized' : 'initialized_existing' };
    });
  }

  async function cleanupTag(customerId) {
    if (!writesEnabled()) return { outcome: 'skipped_writes_disabled' };
    const c = await shopify.getCustomer(customerId);
    if (c?.signed === true) return { outcome: await applySigned(customerId) };
    return { outcome: 'skipped_not_signed' };
  }

  /** Storefront status (server-verified). Rechecks GHL at most every STATUS_RECHECK_SECONDS per customer. */
  const lastCheck = new Map();
  async function storefrontStatus(customerId, { recheck = false } = {}) {
    const customer = await shopify.getCustomer(customerId);
    if (!customer) return { required: false, signed: false, reason: 'customer_not_found' };
    if (!isProvider(customer, providerTags)) return { required: false, signed: false };
    if (customer.signed === true) return { required: true, signed: true };

    const now = Date.now();
    const since = now - (lastCheck.get(customerId) ?? 0);
    if (!recheck && since < cfg.sync.statusRecheckSeconds * 1000) return { required: true, signed: false, syncing: true };
    lastCheck.set(customerId, now);

    const contact = await resolveContact(customer);
    if (!contact) return { required: true, signed: false, reason: 'no_ghl_contact' };
    const v = await verifyContact(contact.contactId);
    if (!v.signed) return { required: true, signed: false };
    const m = await matchSigner(v.signature);
    if (m.status !== 'matched' || m.customer.id !== customerId) return { required: true, signed: false, reason: 'identity_review' };
    await applySigned(customerId, contact.contactId);
    const confirmed = await shopify.getCustomer(customerId);
    return { required: true, signed: confirmed?.signed === true };
  }

  async function invitation(customerId) {
    const customer = await shopify.getCustomer(customerId);
    if (!customer || !isProvider(customer, providerTags)) return { status: 'not_required' };
    const contact = await resolveContact(customer);
    const prefill = { firstName: customer.firstName, lastName: customer.lastName, email: customer.email };
    if (!contact) return { status: 'not_found', prefill };
    const c = await ghl.getContact(contact.contactId);
    const docs = c?.email ? await ghl.documentsForEmail(c.email) : [];
    const mappings = await repo.loadMappings(db, docs.map(documentId).filter(Boolean));
    return { ...pickActiveInvitation(docs, contact.contactId, agreementCfg, mappings), prefill };
  }

  async function requestResend(customerId) {
    const { mode, tag, cooldownHours } = cfg.recovery;
    if (mode !== 'tag') return { status: 'unavailable' };
    const customer = await shopify.getCustomer(customerId);
    if (!customer || !isProvider(customer, providerTags)) return { status: 'unavailable' };
    const contact = await resolveContact(customer);
    if (!contact) return { status: 'unavailable' };
    const r = await db.query(
      `INSERT INTO resend_requests (ghl_contact_id, status) VALUES ($1, 'requested')
       ON CONFLICT (ghl_contact_id) DO UPDATE SET requested_at = now(), status = 'requested'
       WHERE resend_requests.requested_at < now() - ($2 || ' hours')::interval
       RETURNING ghl_contact_id`,
      [contact.contactId, String(cooldownHours)],
    );
    if (!r.rows.length) return { status: 'already_requested' };
    try {
      await ghl.addContactTags(contact.contactId, [tag]);
      return { status: 'requested' };
    } catch (err) {
      log.error('resend request failed', { err });
      await db.query('DELETE FROM resend_requests WHERE ghl_contact_id = $1', [contact.contactId]);
      return { status: 'unavailable' };
    }
  }

  return {
    evaluateDocs,
    matchSigner,
    applySigned,
    verifyContact,
    syncContact,
    initCustomer,
    cleanupTag,
    resolveContact,
    storefrontStatus,
    invitation,
    requestResend,
    agreementCfg,
    writesEnabled,
  };
}
