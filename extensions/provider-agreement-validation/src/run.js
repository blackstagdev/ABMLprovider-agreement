// Pure validation rule (no imports from @shopify/shopify_function so it is unit-testable in Node).
import { GUEST_POLICY, MESSAGES } from './policy.js';

const NO_CHANGES = { operations: [] };
const block = (message) => ({ operations: [{ validationAdd: { errors: [{ message, target: '$.cart' }] } }] });

/**
 * @param {any} input result of run.graphql
 * @param {{guestPolicy?: 'block'|'allow'}} [opts]
 */
export function cartValidationsGenerateRun(input, opts = {}) {
  const guestPolicy = opts.guestPolicy ?? GUEST_POLICY;
  // Cart editing stays available: only enforce once the buyer is in checkout.
  if (input?.buyerJourney?.step === 'CART_INTERACTION') return NO_CHANGES;

  const customer = input?.cart?.buyerIdentity?.customer ?? null;
  if (!customer) return guestPolicy === 'block' ? block(MESSAGES.loginRequired) : NO_CHANGES;
  if (customer.isProvider !== true) return NO_CHANGES; // retail / non-provider customers are unaffected
  if (customer.agreement?.value === 'true') return NO_CHANGES;
  return block(MESSAGES.signatureRequired); // false or missing => signature required
}
