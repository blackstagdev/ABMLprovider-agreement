// Pure identity matching between a GHL signer contact and Shopify customers.
// Stored cross-platform IDs win; a normalized email is used only when it is unique on both sides.

export function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/**
 * @param {object} input
 * @param {string} input.contactId                 GHL contact id of the signer
 * @param {string|null} input.recipientEmail       email on the document recipient
 * @param {object|null} input.ghlContact           { id, email, shopifyCustomerId }
 * @param {number} input.ghlContactsWithEmail      how many GHL contacts share the normalized email
 * @param {Array}  input.shopifyByStoredId         Shopify customers whose GHL-id metafield == contactId
 * @param {object|null} input.shopifyByGhlField    Shopify customer referenced by the GHL contact's Shopify-id field
 * @param {Array}  input.shopifyByEmail            Shopify customers with the normalized email
 * @param {string|null} input.linkedCustomerId     previously confirmed link (customer_links)
 * @param {Array<{email: string, shopify: Array, ghlContactIds: string[]}>} [input.emailCandidates]
 *        Preferred over ghlContactsWithEmail/shopifyByEmail: one entry per distinct email of this signer
 *        (the agreement recipient email and the contact's current email). Each lists the Shopify
 *        customers and the GHL contact ids that have that email.
 * @returns {{status: 'matched'|'missing'|'ambiguous', customer?: object, method?: string, reason?: string}}
 */
export function matchIdentity(input) {
  const {
    contactId,
    recipientEmail,
    ghlContact = null,
    ghlContactsWithEmail = 0,
    shopifyByStoredId = [],
    shopifyByGhlField = null,
    shopifyByEmail = [],
    linkedCustomerId = null,
    emailCandidates = null,
  } = input;

  const recipientNorm = normalizeEmail(recipientEmail);
  const contactNorm = normalizeEmail(ghlContact?.email);
  const emailChanged = !!(recipientNorm && contactNorm && recipientNorm !== contactNorm);
  // Without per-email lookups we can't tell an email change from a collision: send it to review.
  if (emailChanged && !emailCandidates) {
    return { status: 'ambiguous', reason: 'recipient_email_differs_from_contact' };
  }

  // 1. Stored cross-platform IDs.
  const byId = new Map();
  for (const c of shopifyByStoredId) byId.set(c.id, c);
  if (shopifyByGhlField) byId.set(shopifyByGhlField.id, shopifyByGhlField);
  if (linkedCustomerId && !byId.has(linkedCustomerId)) {
    const fromEmail = shopifyByEmail.find((c) => c.id === linkedCustomerId);
    byId.set(linkedCustomerId, fromEmail ?? { id: linkedCustomerId });
  }
  if (byId.size > 1) return { status: 'ambiguous', reason: 'conflicting_stored_ids' };
  if (byId.size === 1) {
    const customer = [...byId.values()][0];
    if (customer.ghlContactId && customer.ghlContactId !== contactId) {
      return { status: 'ambiguous', reason: 'customer_linked_to_other_contact' };
    }
    return { status: 'matched', customer, method: linkedCustomerId === customer.id ? 'confirmed_link' : 'stored_id' };
  }

  // 2. Normalized email(s), only when they identify the same person on both sides.
  if (emailCandidates) return matchByEmails(contactId, emailCandidates, emailChanged);
  const email = recipientNorm ?? contactNorm;
  if (!email) return { status: 'missing', reason: 'no_email' };
  if (ghlContactsWithEmail > 1) return { status: 'ambiguous', reason: 'shared_email_in_ghl' };
  if (shopifyByEmail.length === 0) return { status: 'missing', reason: 'no_shopify_customer' };
  if (shopifyByEmail.length > 1) return { status: 'ambiguous', reason: 'shared_email_in_shopify' };
  const customer = shopifyByEmail[0];
  if (customer.ghlContactId && customer.ghlContactId !== contactId) {
    return { status: 'ambiguous', reason: 'customer_linked_to_other_contact' };
  }
  return { status: 'matched', customer, method: 'email' };
}

/**
 * Email matching across the signer's emails (agreement email and, if it changed, the current one).
 * The signer is already pinned to one GHL contact by the document's recipient id; the email is only
 * the bridge to Shopify. Matched only when no OTHER GHL contact uses any of the emails and all of
 * them together point at exactly one Shopify customer.
 */
function matchByEmails(contactId, candidates, emailChanged) {
  const usable = candidates.filter((c) => normalizeEmail(c.email));
  if (!usable.length) return { status: 'missing', reason: 'no_email' };
  if (usable.some((c) => (c.ghlContactIds ?? []).some((id) => id !== contactId))) {
    return { status: 'ambiguous', reason: 'shared_email_in_ghl' };
  }
  const customers = new Map();
  for (const c of usable) for (const cust of c.shopify ?? []) customers.set(cust.id, cust);
  if (customers.size === 0) return { status: 'missing', reason: 'no_shopify_customer' };
  if (customers.size > 1) {
    return { status: 'ambiguous', reason: emailChanged ? 'emails_match_different_customers' : 'shared_email_in_shopify' };
  }
  const customer = [...customers.values()][0];
  if (customer.ghlContactId && customer.ghlContactId !== contactId) {
    return { status: 'ambiguous', reason: 'customer_linked_to_other_contact' };
  }
  return { status: 'matched', customer, method: emailChanged ? 'email_changed_after_signing' : 'email' };
}
