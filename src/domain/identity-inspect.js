// Discover where the existing GHL -> Shopify registration stores cross-platform IDs, from samples of
// real provider records. Reports only field names and counts (never values, emails or names).

const digits = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * @param {Array<{customer: {id: string, note?: string, metafields: Array<{namespace,key,value}>},
 *                ghlContact: null | {id: string, customFields: Array<{id, value}>}, ghlMatches: number}>} samples
 * @param {Map<string,string>} [fieldNames] GHL custom field id -> display name
 */
export function analyzeIdentity(samples, fieldNames = new Map()) {
  const metafields = new Map(); // "ns.key" -> {present, equalsGhlContactId}
  const ghlFields = new Map(); // field id -> {present, equalsShopifyCustomerId}
  let noteHasGhlId = 0;
  const email = { uniqueGhlContact: 0, noGhlContact: 0, multipleGhlContacts: 0 };

  for (const s of samples) {
    if (s.ghlMatches === 1) email.uniqueGhlContact++;
    else if (s.ghlMatches === 0) email.noGhlContact++;
    else email.multipleGhlContacts++;

    const contactId = s.ghlContact?.id ?? null;
    for (const m of s.customer.metafields ?? []) {
      const k = `${m.namespace}.${m.key}`;
      const e = metafields.get(k) ?? { present: 0, equalsGhlContactId: 0 };
      e.present++;
      if (contactId && String(m.value).trim() === contactId) e.equalsGhlContactId++;
      metafields.set(k, e);
    }
    if (contactId && (s.customer.note ?? '').includes(contactId)) noteHasGhlId++;

    const shopifyNumeric = digits(s.customer.id);
    for (const f of s.ghlContact?.customFields ?? []) {
      const e = ghlFields.get(f.id) ?? { present: 0, equalsShopifyCustomerId: 0 };
      e.present++;
      if (shopifyNumeric && digits(Array.isArray(f.value) ? f.value[0] : f.value) === shopifyNumeric) e.equalsShopifyCustomerId++;
      ghlFields.set(f.id, e);
    }
  }

  const comparable = email.uniqueGhlContact;
  const best = (map, prop) =>
    [...map.entries()].filter(([, v]) => v[prop] > 0).sort((a, b) => b[1][prop] - a[1][prop])[0] ?? null;
  const bestMeta = best(metafields, 'equalsGhlContactId');
  const bestField = best(ghlFields, 'equalsShopifyCustomerId');
  const strong = (n) => comparable > 0 && n / comparable >= 0.5;

  const recommendations = [];
  if (bestMeta && strong(bestMeta[1].equalsGhlContactId)) {
    recommendations.push(`SHOPIFY_GHL_CONTACT_ID_METAFIELD=${bestMeta[0]}  (matches the GHL contact id on ${bestMeta[1].equalsGhlContactId}/${comparable} providers)`);
  }
  if (bestField && strong(bestField[1].equalsShopifyCustomerId)) {
    const name = fieldNames.get(bestField[0]);
    recommendations.push(`GHL_SHOPIFY_CUSTOMER_ID_FIELD_ID=${bestField[0]}${name ? ` ("${name}")` : ''}  (matches the Shopify customer id on ${bestField[1].equalsShopifyCustomerId}/${comparable} providers)`);
  }
  if (!recommendations.length) {
    recommendations.push(
      'No stored cross-platform ID found. The registration workflow links records by email only. Leave SHOPIFY_GHL_CONTACT_ID_METAFIELD and GHL_SHOPIFY_CUSTOMER_ID_FIELD_ID at their defaults/blank: the app falls back to unique-email matching and sends shared or duplicate emails to review.',
    );
  }
  if (email.multipleGhlContacts) recommendations.push(`${email.multipleGhlContacts} sampled providers share an email with another GHL contact; these will be routed to review.`);

  return {
    sampled: samples.length,
    email,
    shopifyMetafields: Object.fromEntries([...metafields.entries()].sort()),
    ghlCustomFields: Object.fromEntries([...ghlFields.entries()].map(([id, v]) => [fieldNames.get(id) ? `${id} (${fieldNames.get(id)})` : id, v])),
    customerNoteContainsGhlId: noteHasGhlId,
    recommendations,
  };
}
