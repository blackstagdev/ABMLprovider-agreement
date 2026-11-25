// Function policy. Changing these requires `shopify app deploy`.
// PROVIDER_TAGS must match the hasAnyTag() list in run.graphql (Functions can't take runtime tag lists
// without input variables).
export const PROVIDER_TAGS = ['wholesale'];

// Guest (logged-out) checkouts. The theme only sells to logged-in "wholesale" providers, so a logged-out
// checkout cannot be identified as a provider or a retail buyer.
//  'block' = require login before completing checkout (recommended for a provider-only store)
//  'allow' = let guests through (only if the store also sells to anonymous retail buyers)
// CONFIRM WITH THE MERCHANT BEFORE ENABLING THE VALIDATION.
export const GUEST_POLICY = 'block';

export const MESSAGES = {
  signatureRequired:
    'Please sign your Alpha BioMed Provider Agreement before checking out. Return to your cart to sign it; your cart is saved.',
  loginRequired: 'Please log in to your Alpha BioMed provider account to check out.',
};
