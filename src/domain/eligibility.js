// Who must have a signed agreement to check out.
// The rule is the provider tag set by the existing GHL -> Shopify registration ("wholesale" in the
// current theme). It deliberately ignores the temporary pending tag.

export function isProvider(customer, providerTags) {
  if (!customer) return false;
  const tags = (customer.tags ?? []).map((t) => t.toLowerCase());
  return providerTags.some((t) => tags.includes(t.toLowerCase()));
}

/** Server-side mirror of the checkout Function rule (kept in sync by tests). */
export function checkoutDecision({ customer, providerTags, guestPolicy = 'block' }) {
  if (!customer) return guestPolicy === 'block' ? { allowed: false, reason: 'login_required' } : { allowed: true };
  if (!isProvider(customer, providerTags)) return { allowed: true, reason: 'not_provider' };
  return customer.signed === true ? { allowed: true } : { allowed: false, reason: 'signature_required' };
}
