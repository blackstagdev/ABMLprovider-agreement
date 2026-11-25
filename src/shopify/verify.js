// Inbound authentication for Shopify webhooks and app-proxy (storefront) requests.
import crypto from 'node:crypto';

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** X-Shopify-Hmac-Sha256: base64 HMAC-SHA256 of the raw body with the app's client secret. */
export function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(digest, hmacHeader);
}

/**
 * App proxy: `signature` is hex HMAC-SHA256 over the other query params, each rendered as
 * key=value (multi-values joined with ","), sorted, concatenated with no separator.
 * Also rejects stale timestamps (replay window).
 */
export function verifyAppProxy(searchParams, secret, { maxAgeSeconds = 300, now = Date.now() } = {}) {
  const signature = searchParams.get('signature');
  if (!signature || !secret) return { ok: false };
  const grouped = new Map();
  for (const [k, v] of searchParams) {
    if (k === 'signature') continue;
    grouped.set(k, grouped.has(k) ? [...grouped.get(k), v] : [v]);
  }
  const message = [...grouped.entries()].map(([k, vs]) => `${k}=${vs.join(',')}`).sort().join('');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  if (!safeEqual(digest, signature)) return { ok: false };
  const ts = Number(searchParams.get('timestamp'));
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > maxAgeSeconds) return { ok: false, reason: 'stale' };
  const cid = searchParams.get('logged_in_customer_id') || null;
  return { ok: true, shop: searchParams.get('shop'), customerId: cid ? `gid://shopify/Customer/${cid}` : null };
}

export function signAppProxyForTest(params, secret) {
  const message = Object.entries(params).map(([k, v]) => `${k}=${v}`).sort().join('');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}
