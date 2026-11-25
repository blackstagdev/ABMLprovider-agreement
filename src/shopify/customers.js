// Shopify customer reads/writes for the agreement flag and pending tag.
import { normalizeEmail } from '../domain/identity.js';

export function createShopifyCustomers(admin, cfg) {
  const { signedMetafield: sm, ghlContactIdMetafield: gm } = cfg;
  const FIELDS = `
    id email firstName lastName tags
    signed: metafield(namespace: "${sm.namespace}", key: "${sm.key}") { value }
    ghl: metafield(namespace: "${gm.namespace}", key: "${gm.key}") { value }`;

  const toCustomer = (c) =>
    c && {
      id: c.id,
      email: c.email ?? null,
      firstName: c.firstName ?? null,
      lastName: c.lastName ?? null,
      tags: c.tags ?? [],
      signed: c.signed?.value === 'true' ? true : c.signed?.value === 'false' ? false : null,
      ghlContactId: c.ghl?.value || null,
    };

  const assertNoUserErrors = (label, r) => {
    const errs = r?.userErrors ?? [];
    if (errs.length) throw new Error(`${label}: ${errs.map((e) => e.code || e.message).join('; ')}`);
  };

  return {
    async getCustomer(id) {
      const d = await admin.graphql(`query($id: ID!) { customer(id: $id) { ${FIELDS} } }`, { id });
      return toCustomer(d.customer);
    },

    async findByEmail(email) {
      const norm = normalizeEmail(email);
      if (!norm) return [];
      const d = await admin.graphql(
        `query($q: String!) { customers(first: 10, query: $q) { nodes { ${FIELDS} } } }`,
        { q: `email:"${norm.replace(/"/g, '')}"` },
      );
      return d.customers.nodes.map(toCustomer).filter((c) => normalizeEmail(c.email) === norm);
    },

    /** Page through customers (used by the backfill to index stored GHL IDs and emails). */
    async *allCustomers(query = null) {
      let after = null;
      for (;;) {
        const d = await admin.graphql(
          `query($after: String, $q: String) { customers(first: 250, after: $after, query: $q) {
             nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } } }`,
          { after, q: query },
        );
        for (const n of d.customers.nodes) yield toCustomer(n);
        if (!d.customers.pageInfo.hasNextPage) return;
        after = d.customers.pageInfo.endCursor;
      }
    },

    /** Write true (idempotent) and read back to confirm. */
    async setSigned(id) {
      const d = await admin.graphql(
        `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { value } userErrors { field message code } } }`,
        { m: [{ ownerId: id, namespace: sm.namespace, key: sm.key, type: 'boolean', value: 'true' }] },
      );
      assertNoUserErrors('metafieldsSet(true)', d.metafieldsSet);
      const after = await this.getCustomer(id);
      if (after?.signed !== true) throw new Error('Signed flag did not read back as true');
      return after;
    },

    /**
     * Initialize false ONLY if the metafield does not exist yet (compareDigest: null),
     * so a delayed initialization can never overwrite a verified `true`.
     * @returns {'created'|'exists'}
     */
    async initUnsigned(id) {
      const d = await admin.graphql(
        `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { value } userErrors { field message code } } }`,
        { m: [{ ownerId: id, namespace: sm.namespace, key: sm.key, type: 'boolean', value: 'false', compareDigest: null }] },
      );
      const errs = d.metafieldsSet?.userErrors ?? [];
      if (errs.some((e) => e.code === 'STALE_OBJECT' || /stale|already exists|digest/i.test(e.message))) return 'exists';
      assertNoUserErrors('metafieldsSet(init false)', d.metafieldsSet);
      return 'created';
    },

    async addTag(id, tag) {
      const d = await admin.graphql(
        `mutation($id: ID!, $t: [String!]!) { tagsAdd(id: $id, tags: $t) { userErrors { field message } } }`,
        { id, t: [tag] },
      );
      assertNoUserErrors('tagsAdd', d.tagsAdd);
    },

    async removeTag(id, tag) {
      const d = await admin.graphql(
        `mutation($id: ID!, $t: [String!]!) { tagsRemove(id: $id, tags: $t) { userErrors { field message } } }`,
        { id, t: [tag] },
      );
      assertNoUserErrors('tagsRemove', d.tagsRemove);
    },
  };
}
