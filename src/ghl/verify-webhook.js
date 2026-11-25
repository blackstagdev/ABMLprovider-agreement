// Authenticate inbound GHL events.
// - Workflow "Custom Webhook" action: shared secret in the `X-ABM-Webhook-Secret` header (or
//   `Authorization: Bearer <secret>`), configured in the GHL action's headers.
// - Marketplace-style signed deliveries: Ed25519 `X-GHL-Signature` over the raw body
//   (the legacy RSA `X-WH-Signature` was retired on 2026-09-01 and is not accepted).
import crypto from 'node:crypto';
import { safeEqual } from '../shopify/verify.js';

export const GHL_ED25519_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n-----END PUBLIC KEY-----\n';

export function verifyGhlEvent({ headers, rawBody, secret, publicKeyPem = GHL_ED25519_PUBLIC_KEY_PEM }) {
  const shared = headers['x-abm-webhook-secret'] || (headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (secret && shared && safeEqual(shared, secret)) return { ok: true, method: 'shared_secret' };
  const sig = headers['x-ghl-signature'];
  if (sig) {
    try {
      const ok = crypto.verify(null, rawBody, publicKeyPem, Buffer.from(sig, 'base64'));
      if (ok) return { ok: true, method: 'ed25519' };
    } catch {
      /* fall through */
    }
  }
  return { ok: false };
}

/** Extract identifiers from a workflow webhook body (field names vary by how the action is configured). */
export function parseGhlEventBody(body) {
  const b = body ?? {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), b);
      if (v) return String(v);
    }
    return null;
  };
  return {
    contactId: pick('contact_id', 'contactId', 'contact.id'),
    email: pick('email', 'contact.email'),
    documentId: pick('document_id', 'documentId', 'document.id', 'customData.document_id'),
    locationId: pick('location_id', 'locationId', 'location.id'),
  };
}
