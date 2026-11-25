// Read-only export: which Shopify providers do NOT have "Provider agreement signed" = true, and why.
// Sources: Shopify (live customers + metafield), this app's database (backfill run + verified
// signatures + confirmed links) and GHL (contacts by email). Writes nothing anywhere.
import { normalizeEmail } from '../domain/identity.js';

export const STATUS = {
  signed_not_applied: 'Signed in GHL, not yet written to Shopify',
  needs_review: 'Signed in GHL, needs review (identity unclear)',
  sent_not_signed: 'Agreement sent, not signed',
  no_agreement: 'GHL contact found, no agreement sent',
  no_ghl_contact: 'No GHL contact with this email',
  no_email: 'Shopify customer has no email',
};

export const ACTION = {
  signed_not_applied: 'Re-run: npm run backfill -- --apply --confirm (or wait for the reconciler once writes are on).',
  needs_review: 'Merge duplicate GHL contacts / Shopify customers, then re-run the apply.',
  sent_not_signed: 'Provider must sign from the Alpha BioMed Support email. To resend, add GHL tag provider-agreement-resend.',
  no_agreement: 'Send the agreement: move the opportunity to stage "Send Document" (or add tag provider-agreement-resend).',
  no_ghl_contact: 'Find the provider in GHL (maybe under another email) and align the emails, or create the contact.',
  no_email: 'Add an email to the Shopify customer so it can be matched to GHL.',
};

const RANK = ['newly_signed', 'already_signed', 'ambiguous', 'missing', 'failed', 'unresolved', 'not_signed'];

/** Latest completed apply run (falls back to the latest completed run of any mode). */
export async function latestRun(db) {
  const r = await db.query(
    `SELECT id, mode FROM backfill_runs WHERE status = 'completed' ORDER BY (mode = 'apply') DESC, id DESC LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

/** Per-contact facts from the database. */
export async function loadDbFacts(db, runId) {
  const byContact = new Map();
  const recs = (
    await db.query(
      `SELECT ghl_contact_id, outcome, coalesce(detail->>'reason', detail->>'method', detail->>'error', '') AS reason, document_id
       FROM backfill_records WHERE run_id = $1 AND ghl_contact_id IS NOT NULL`,
      [runId],
    )
  ).rows;
  for (const r of recs) {
    const f = byContact.get(r.ghl_contact_id) ?? { outcomes: {}, best: null, bestReason: '', invitations: 0, lastDocumentId: null };
    f.outcomes[r.outcome] = (f.outcomes[r.outcome] ?? 0) + 1;
    if (r.outcome === 'not_signed') f.invitations++;
    if (!f.best || RANK.indexOf(r.outcome) < RANK.indexOf(f.best)) {
      f.best = r.outcome;
      f.bestReason = r.reason;
    }
    if (!f.lastDocumentId || r.document_id > f.lastDocumentId) f.lastDocumentId = r.document_id; // GHL ids are time-ordered
    byContact.set(r.ghl_contact_id, f);
  }
  const signatures = new Map(
    (await db.query('SELECT ghl_contact_id, signed_at, applied_at, shopify_customer_id FROM verified_signatures')).rows.map((r) => [r.ghl_contact_id, r]),
  );
  const links = new Map((await db.query('SELECT shopify_customer_id, ghl_contact_id FROM customer_links')).rows.map((r) => [r.shopify_customer_id, r.ghl_contact_id]));
  const written = (
    await db.query(`SELECT count(DISTINCT shopify_customer_id)::int AS n FROM backfill_records WHERE run_id = $1 AND outcome = 'newly_signed'`, [runId])
  ).rows[0].n;
  const review = (
    await db.query(
      `SELECT outcome, coalesce(detail->>'reason', detail->>'error', '') AS reason, document_id, ghl_contact_id
       FROM backfill_records WHERE run_id = $1 AND outcome IN ('ambiguous', 'missing', 'failed') ORDER BY outcome, reason, ghl_contact_id`,
      [runId],
    )
  ).rows;
  return { byContact, signatures, links, written, review };
}

/** Decide why a provider customer is not filled, from the GHL contacts found for it. */
export function classify(customer, contacts, facts) {
  if (!normalizeEmail(customer.email) && !contacts.length) return 'no_email';
  if (!contacts.length) return 'no_ghl_contact';
  const f = contacts.map((c) => facts.byContact.get(c.id)).filter(Boolean);
  if (contacts.some((c) => facts.signatures.has(c.id)) || f.some((x) => x.best === 'newly_signed' || x.best === 'already_signed')) {
    return f.some((x) => x.best === 'ambiguous') || contacts.length > 1 ? 'needs_review' : 'signed_not_applied';
  }
  if (f.some((x) => ['ambiguous', 'missing', 'failed'].includes(x.best))) return 'needs_review';
  if (f.some((x) => x.invitations > 0)) return 'sent_not_signed';
  return 'no_agreement';
}

export const isProvider = (customer, providerTags) => (customer.tags ?? []).some((t) => providerTags.includes(t));

/**
 * Build all sheet rows. `lookupContacts(customer)` returns the GHL contacts for a customer
 * (raw GHL contact objects with id/email/phone/firstName/lastName/tags/dateAdded).
 */
export async function buildExport({ customers, facts, providerTags, lookupContacts, getContact, links: urls, onProgress = () => {} }) {
  const notFilled = [];
  const filledNotProvider = [];
  const counts = { customers: 0, signedTrue: 0, providers: 0, providerTrue: 0, providerFalse: 0, providerMissing: 0, signedNotProvider: 0 };
  const byStatus = Object.fromEntries(Object.keys(STATUS).map((k) => [k, 0]));
  const byEmail = new Map();

  const unfilled = [];
  for (const c of customers) {
    counts.customers++;
    const e = normalizeEmail(c.email);
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), c]);
    const provider = isProvider(c, providerTags);
    if (c.signed === true) counts.signedTrue++;
    if (provider) {
      counts.providers++;
      if (c.signed === true) counts.providerTrue++;
      else {
        if (c.signed === false) counts.providerFalse++;
        else counts.providerMissing++;
        unfilled.push(c);
      }
    } else if (c.signed === true) {
      counts.signedNotProvider++;
      filledNotProvider.push(customerColumns(c, urls));
    }
  }

  let done = 0;
  for (const c of unfilled) {
    const linked = facts.links.get(c.id);
    const contacts = linked ? [(await getContact(linked)) ?? { id: linked }] : await lookupContacts(c);
    const status = classify(c, contacts, facts);
    byStatus[status]++;
    const f = contacts.map((x) => facts.byContact.get(x.id)).filter(Boolean);
    const main = contacts[0] ?? null;
    const sig = contacts.map((x) => facts.signatures.get(x.id)).find(Boolean);
    notFilled.push({
      status: STATUS[status],
      action: ACTION[status],
      ...customerColumns(c, urls),
      metafield: c.signed === false ? 'false' : 'not set',
      ghlContacts: contacts.length,
      ghlContactId: contacts.map((x) => x.id).join(', '),
      ghlName: main ? [main.firstName, main.lastName].filter(Boolean).join(' ') : '',
      ghlEmail: main?.email ?? '',
      ghlPhone: main?.phone ?? '',
      ghlTags: (main?.tags ?? []).join(', '),
      ghlAdded: dateOnly(main?.dateAdded),
      invitations: f.reduce((n, x) => n + x.invitations, 0),
      lastDocumentId: f.map((x) => x.lastDocumentId).filter(Boolean).sort().pop() ?? '',
      backfillOutcome: f.map((x) => x.best).filter(Boolean).join(', '),
      backfillReason: f.map((x) => x.bestReason).filter(Boolean).join(', '),
      signedAt: dateOnly(sig?.signed_at),
      ghlLink: main ? urls.ghlContact(main.id) : '',
    });
    if (++done % 100 === 0) onProgress(done, unfilled.length);
  }
  onProgress(done, unfilled.length);

  const review = [];
  for (const r of facts.review) {
    const contact = await getContact(r.ghl_contact_id);
    const shop = contact?.email ? (byEmail.get(normalizeEmail(contact.email)) ?? []) : [];
    review.push({
      outcome: r.outcome,
      reason: r.reason,
      explanation: REVIEW_HELP[r.reason] ?? '',
      ghlContactId: r.ghl_contact_id,
      ghlName: contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') : '(contact deleted in GHL)',
      ghlEmail: contact?.email ?? '',
      documentId: r.document_id,
      shopifyCustomers: shop.map((s) => [s.firstName, s.lastName].filter(Boolean).join(' ') + ` <${s.legacyId}>`).join('; '),
      ghlLink: urls.ghlContact(r.ghl_contact_id),
    });
  }

  notFilled.sort((a, b) => a.status.localeCompare(b.status) || a.email.localeCompare(b.email));
  return { counts, byStatus, notFilled, filledNotProvider, review };
}

const REVIEW_HELP = {
  shared_email_in_ghl: 'Another GHL contact uses the same email (likely a duplicate). Merge the GHL contacts.',
  emails_match_different_customers: "The signer's old and new emails belong to two different Shopify customers. Merge them in Shopify.",
  ghl_contact_not_found: 'The signing GHL contact was deleted or merged. Find the provider and check manually.',
  no_shopify_customer: 'Signed in GHL but no Shopify customer with this email. Applied automatically once the customer exists (writes on).',
};

function customerColumns(c, urls) {
  return {
    name: [c.firstName, c.lastName].filter(Boolean).join(' '),
    email: c.email ?? '',
    company: c.company ?? '',
    location: [c.city, c.province, c.country].filter(Boolean).join(', '),
    tags: (c.tags ?? []).join(', '),
    accountState: c.state ?? '',
    orders: c.orders ?? 0,
    amountSpent: c.amountSpent ?? 0,
    currency: c.currency ?? '',
    createdAt: dateOnly(c.createdAt),
    shopifyCustomerId: c.legacyId ?? c.id,
    shopifyLink: urls.shopifyCustomer(c.legacyId),
  };
}

const dateOnly = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
