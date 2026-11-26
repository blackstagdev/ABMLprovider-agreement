// Central configuration. Every value comes from the environment; see .env.example.

export const SHOPIFY_API_VERSION = '2026-10'; // pinned Admin GraphQL API version
export const GHL_API_BASE = 'https://services.leadconnectorhq.com';
export const GHL_DOCUMENTS_VERSION = 'v3'; // Version header documented for /proposals/*
export const GHL_CONTACTS_VERSION = '2021-07-28';
// Live API (2026-11-26 probe): GET /proposals/document rejects limit > 20 and requires limit.
export const GHL_DOCUMENTS_MAX_LIMIT = 20;

const list = (v, fallback) =>
  (v ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
const bool = (v, fallback = false) =>
  v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v);
const int = (v, fallback) => (v === undefined || v === '' ? fallback : Number.parseInt(v, 10));

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL,
    appUrl: env.APP_URL,

    shopify: {
      shop: env.SHOPIFY_SHOP, // e.g. alphabiomedlabs.myshopify.com
      clientId: env.SHOPIFY_API_KEY,
      clientSecret: env.SHOPIFY_API_SECRET, // also the app-proxy + webhook HMAC key
      staticAccessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN || null,
      // Provider eligibility: independent of the pending tag.
      providerTags: list(env.PROVIDER_TAGS, 'wholesale'),
      pendingTag: env.PENDING_TAG || 'provider-agreement-pending',
      signedMetafield: { namespace: 'custom', key: 'provider_agreement_signed' },
      // Existing cross-platform identity (set by the GHL -> Shopify registration workflow).
      ghlContactIdMetafield: parseNsKey(env.SHOPIFY_GHL_CONTACT_ID_METAFIELD || 'custom.ghl_contact_id'),
    },

    ghl: {
      token: env.GHL_PRIVATE_INTEGRATION_TOKEN,
      locationId: env.GHL_LOCATION_ID,
      agreementName: env.AGREEMENT_DOCUMENT_NAME || 'Alpha BioMed Provider Agreement',
      agreementTemplateId: env.AGREEMENT_TEMPLATE_ID || null,
      // GHL contact custom field holding the Shopify customer ID (if the registration workflow stores one).
      shopifyIdCustomFieldId: env.GHL_SHOPIFY_CUSTOMER_ID_FIELD_ID || null,
      webhookSecret: env.GHL_WEBHOOK_SECRET,
      requireSignedDate: bool(env.REQUIRE_SIGNED_DATE, true),
      // Light scan every RECONCILE_INTERVAL_MINUTES; full scan once a day (GHL date filters may be on creation date,
      // so a document created weeks ago and signed today is caught by the deep scan or the workflow event).
      recentLookbackDays: int(env.GHL_RECENT_LOOKBACK_DAYS, 14),
      deepLookbackDays: int(env.GHL_DEEP_LOOKBACK_DAYS, 120),
      requestsPerSecond: int(env.GHL_REQUESTS_PER_SECOND, 8),
      // Documents per /proposals/document request (GHL rejects more than 20).
      pageSize: Math.min(int(env.GHL_PAGE_SIZE, 20), 20),
    },

    recovery: {
      mode: env.RECOVERY_MODE || 'tag', // 'tag' (GHL workflow re-sends) | 'none'
      tag: env.RECOVERY_TAG || 'provider-agreement-resend',
      // Minutes between provider-initiated resends. RECOVERY_COOLDOWN_MINUTES wins; the older
      // RECOVERY_COOLDOWN_HOURS is still honoured if it is the only one set. 0 = no limit.
      cooldownMinutes: env.RECOVERY_COOLDOWN_MINUTES ? int(env.RECOVERY_COOLDOWN_MINUTES, 15) : env.RECOVERY_COOLDOWN_HOURS ? int(env.RECOVERY_COOLDOWN_HOURS, 0) * 60 : 15,
      dripDelayMinutes: int(env.ONBOARDING_DRIP_DELAY_MINUTES, 60),
      supportEmail: env.SUPPORT_EMAIL || 'support@alphabiomedlabs.com',
    },

    backfill: {
      startDate: env.BACKFILL_START_DATE || '2020-01-01',
      windowDays: int(env.BACKFILL_WINDOW_DAYS, 31),
      pageSize: Math.min(int(env.BACKFILL_PAGE_SIZE, int(env.GHL_PAGE_SIZE, 20)), 20),
    },

    sync: {
      workerEnabled: bool(env.WORKER_ENABLED, true),
      // Master switch for automatic Shopify writes (init false + pending tag, applying signatures, tag cleanup).
      // Off until the backfill dry run has been reviewed and applied. `backfill --apply --confirm` writes regardless.
      shopifyWrites: bool(env.SHOPIFY_WRITES_ENABLED, false),
      reconcileIntervalMinutes: int(env.RECONCILE_INTERVAL_MINUTES, 10),
      statusRecheckSeconds: int(env.STATUS_RECHECK_SECONDS, 5),
    },
  };
}

export function parseNsKey(s) {
  const i = s.lastIndexOf('.');
  if (i <= 0) throw new Error(`Expected namespace.key, got "${s}"`);
  return { namespace: s.slice(0, i), key: s.slice(i + 1) };
}

// Config path -> environment variable, so errors name what to set in Render.
export const ENV_NAMES = {
  databaseUrl: 'DATABASE_URL',
  'shopify.shop': 'SHOPIFY_SHOP',
  'shopify.clientId': 'SHOPIFY_API_KEY',
  'shopify.clientSecret': 'SHOPIFY_API_SECRET',
  'ghl.token': 'GHL_PRIVATE_INTEGRATION_TOKEN',
  'ghl.locationId': 'GHL_LOCATION_ID',
};

export function requireKeys(cfg, keys) {
  const missing = keys.filter((k) => {
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), cfg);
    return v === undefined || v === null || v === '';
  });
  if (missing.length) {
    const names = missing.map((k) => ENV_NAMES[k] ?? k).join(', ');
    throw new Error(`Missing environment variables: ${names}. Set them in Render > Environment (or .env locally), then redeploy.`);
  }
}
