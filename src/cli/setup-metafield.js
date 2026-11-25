// npm run setup:metafield
// Creates the Customer metafield definition "Provider agreement signed" (custom.provider_agreement_signed,
// boolean) with customer-account write access disabled. Idempotent: reports an existing definition.
import { loadConfig } from '../config.js';
import { createPgDb } from '../db.js';
import { createShopifyAdmin } from '../shopify/admin.js';

const cfg = loadConfig();
const db = createPgDb(cfg.databaseUrl);
const admin = createShopifyAdmin({ ...cfg.shopify, db });
const { namespace, key } = cfg.shopify.signedMetafield;

try {
  const existing = await admin.graphql(
    `query { metafieldDefinitions(first: 5, ownerType: CUSTOMER, namespace: "${namespace}", key: "${key}") {
       nodes { id name type { name } access { admin customerAccount storefront } } } }`,
  );
  if (existing.metafieldDefinitions.nodes.length) {
    console.log('Definition already exists:', JSON.stringify(existing.metafieldDefinitions.nodes[0], null, 2));
  } else {
    const r = await admin.graphql(
      `mutation($d: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $d) {
         createdDefinition { id name access { customerAccount storefront } } userErrors { field message code } } }`,
      {
        d: {
          name: 'Provider agreement signed',
          namespace,
          key,
          type: 'boolean',
          ownerType: 'CUSTOMER',
          description: 'Synchronized from GoHighLevel (signature authority). true = verified signed provider agreement.',
          access: { customerAccount: 'NONE' },
        },
      },
    );
    const errs = r.metafieldDefinitionCreate.userErrors;
    if (errs.length) throw new Error(errs.map((e) => `${e.code}: ${e.message}`).join('; '));
    console.log('Created:', JSON.stringify(r.metafieldDefinitionCreate.createdDefinition, null, 2));
  }
} finally {
  await db.close();
}
