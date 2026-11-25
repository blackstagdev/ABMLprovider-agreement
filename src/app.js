// HTTP routes. Pure request handler so tests can drive it without a network listener.
import { verifyGhlEvent, parseGhlEventBody } from './ghl/verify-webhook.js';
import { log } from './log.js';
import { verifyAppProxy, verifyShopifyWebhook } from './shopify/verify.js';

const MAX_BODY = 1_000_000;

export async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

export function createApp({ cfg, db, jobs, sync }) {
  const secret = cfg.shopify.clientSecret;
  let warnedShop = false;

  async function proxy(req, res, url, action) {
    const auth = verifyAppProxy(url.searchParams, secret);
    if (!auth.ok) return send(res, 401, { error: 'unauthorized' });
    if (auth.shop && cfg.shopify.shop && auth.shop !== cfg.shopify.shop) return send(res, 401, { error: 'unauthorized' });
    if (!auth.customerId) return send(res, 200, { loggedIn: false, required: false });
    try {
      switch (action) {
        case 'status':
          return send(res, 200, { loggedIn: true, ...(await sync.storefrontStatus(auth.customerId, { recheck: false })) });
        case 'recheck':
          if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
          return send(res, 200, { loggedIn: true, ...(await sync.storefrontStatus(auth.customerId, { recheck: true })) });
        case 'agreement': {
          // Signing URL is returned only to the authenticated customer it belongs to; never logged.
          const inv = await sync.invitation(auth.customerId);
          return send(res, 200, { ...inv, dripDelayMinutes: cfg.recovery.dripDelayMinutes, supportEmail: cfg.recovery.supportEmail });
        }
        case 'resend':
          if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
          return send(res, 200, { ...(await sync.requestResend(auth.customerId)), supportEmail: cfg.recovery.supportEmail });
        default:
          return send(res, 404, { error: 'not_found' });
      }
    } catch (err) {
      log.error('proxy error', { action, err });
      return send(res, 503, { error: 'temporarily_unavailable', supportEmail: cfg.recovery.supportEmail });
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (p === '/healthz' || p === '/health') {
        await db.query('SELECT 1');
        return send(res, 200, { ok: true });
      }

      if (p === '/webhooks/shopify' && req.method === 'POST') {
        const raw = await readRawBody(req);
        if (!verifyShopifyWebhook(raw, req.headers['x-shopify-hmac-sha256'], secret)) return send(res, 401, 'invalid hmac');
        const topic = req.headers['x-shopify-topic'];
        const webhookShop = req.headers['x-shopify-shop-domain'];
        if (webhookShop && cfg.shopify.shop && webhookShop !== cfg.shopify.shop && !warnedShop) {
          warnedShop = true;
          log.warn('webhook store domain differs from SHOPIFY_SHOP; set SHOPIFY_SHOP to the webhook domain', { webhookShop, configuredShop: cfg.shopify.shop });
        }
        const body = JSON.parse(raw.toString('utf8') || '{}');
        if ((topic === 'customers/create' || topic === 'customers/update') && cfg.sync.shopifyWrites) {
          const id = body.admin_graphql_api_id || `gid://shopify/Customer/${body.id}`;
          await jobs.enqueue('init_customer', { customerId: id }, `init_customer:${id}`, { delaySeconds: topic === 'customers/create' ? 5 : 0 });
        } else if (topic === 'customers/redact') {
          const id = `gid://shopify/Customer/${body.customer?.id}`;
          await db.query('DELETE FROM customer_links WHERE shopify_customer_id = $1', [id]);
          await db.query('DELETE FROM customer_state WHERE shopify_customer_id = $1', [id]);
        }
        return send(res, 200, 'ok');
      }

      if (p === '/webhooks/ghl/agreement' && req.method === 'POST') {
        const raw = await readRawBody(req);
        const auth = verifyGhlEvent({ headers: req.headers, rawBody: raw, secret: cfg.ghl.webhookSecret });
        if (!auth.ok) return send(res, 401, 'unauthorized');
        let body;
        try {
          body = JSON.parse(raw.toString('utf8') || '{}');
        } catch {
          return send(res, 400, 'invalid json');
        }
        const ev = parseGhlEventBody(body);
        if (ev.locationId && ev.locationId !== cfg.ghl.locationId) return send(res, 202, { ignored: 'other_location' });
        if (!ev.contactId) return send(res, 400, { error: 'contact_id required' });
        // The event is only a hint: the job re-verifies the signer against the GHL API.
        await jobs.enqueue('verify_contact', { contactId: ev.contactId, documentId: ev.documentId, source: 'workflow_event' }, `verify_contact:${ev.contactId}:${ev.documentId ?? ''}`);
        return send(res, 202, { accepted: true });
      }

      const m = p.match(/^\/proxy\/(status|recheck|agreement|resend)$/);
      if (m) return proxy(req, res, url, m[1]);

      return send(res, 404, 'not found');
    } catch (err) {
      log.error('request failed', { path: p, err });
      return send(res, err.status ?? 500, 'error');
    }
  };
}
