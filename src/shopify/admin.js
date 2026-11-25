// Shopify Admin GraphQL client pinned to SHOPIFY_API_VERSION.
// Token: SHOPIFY_ADMIN_ACCESS_TOKEN if set, otherwise the client credentials grant
// (app and store in the same Dev Dashboard organization), cached in Postgres `shop_sessions`.
import { SHOPIFY_API_VERSION } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createShopifyAdmin({ shop, clientId, clientSecret, staticAccessToken, db, fetchImpl = fetch }) {
  let cached = staticAccessToken ? { token: staticAccessToken, expiresAt: Infinity } : null;

  async function token() {
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    if (db) {
      const r = await db.query('SELECT access_token, expires_at FROM shop_sessions WHERE shop = $1', [shop]);
      const row = r.rows[0];
      if (row && (!row.expires_at || new Date(row.expires_at).getTime() - Date.now() > 5 * 60_000)) {
        cached = { token: row.access_token, expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : Infinity };
        return cached.token;
      }
    }
    const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    if (!res.ok) {
      let reason = '';
      try {
        reason = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
      } catch {}
      const hint =
        res.status === 404
          ? 'store not found at this domain or app not installed: check SHOPIFY_SHOP is the *.myshopify.com domain shown in Shopify admin Settings > Domains, and that the app is installed'
          : res.status === 400
            ? 'check the app is installed on this store and belongs to the same Dev Dashboard organization'
            : '';
      throw new Error(`Shopify client credentials grant failed with ${res.status} for ${shop}${hint ? ` (${hint})` : ''}${reason && !reason.startsWith('<') ? `: ${reason}` : ''}`);
    }
    const j = await res.json();
    const expiresAt = Date.now() + (j.expires_in ?? 86399) * 1000;
    cached = { token: j.access_token, expiresAt };
    if (db) {
      await db.query(
        `INSERT INTO shop_sessions (shop, access_token, scope, expires_at, updated_at) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (shop) DO UPDATE SET access_token=EXCLUDED.access_token, scope=EXCLUDED.scope, expires_at=EXCLUDED.expires_at, updated_at=now()`,
        [shop, j.access_token, j.scope ?? null, new Date(expiresAt).toISOString()],
      );
    }
    return cached.token;
  }

  async function graphql(query, variables = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 401 && attempt === 0 && !staticAccessToken) {
        cached = null;
        if (db) await db.query('DELETE FROM shop_sessions WHERE shop = $1', [shop]);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}`);
      const j = await res.json();
      const throttled = j.errors?.some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled && attempt < 5) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (j.errors?.length) throw new Error(`Shopify GraphQL error: ${[...new Set(j.errors.map((e) => e.message))].slice(0, 3).join("; ")}`);
      return j.data;
    }
  }

  return { graphql };
}
