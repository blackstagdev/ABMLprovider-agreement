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
  } = input;

  const recipientNorm = normalizeEmail(recipientEmail);
  const contactNorm = normalizeEmail(ghlContact?.email);
  if (recipientNorm && contactNorm && recipientNorm !== contactNorm) {
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

  // 2. Normalized email, only when unique on both sides.
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
