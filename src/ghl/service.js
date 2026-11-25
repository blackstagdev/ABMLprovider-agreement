// Higher-level GHL operations used by sync, backfill and the storefront.
import { normalizeEmail } from '../domain/identity.js';

export function createGhlService(client, cfg) {
  const contactCache = new Map();
  const pageSize = cfg.pageSize ?? 20;

  function toContact(c) {
    if (!c) return null;
    let shopifyCustomerId = null;
    if (cfg.shopifyIdCustomFieldId && Array.isArray(c.customFields)) {
      const f = c.customFields.find((x) => x.id === cfg.shopifyIdCustomFieldId);
      if (f?.value) shopifyCustomerId = toCustomerGid(String(f.value));
    }
    return { id: c.id, email: c.email ?? null, firstName: c.firstName ?? null, lastName: c.lastName ?? null, shopifyCustomerId };
  }

  return {
    async getContact(id) {
      if (contactCache.has(id)) return contactCache.get(id);
      let c = null;
      try {
        c = toContact(await client.getContact(id));
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      contactCache.set(id, c);
      return c;
    },
    async contactsWithEmail(email) {
      const norm = normalizeEmail(email);
      if (!norm) return [];
      const found = await client.searchContactsByEmail(norm);
      return found.filter((c) => normalizeEmail(c.email) === norm).map(toContact);
    },
    async countContactsWithEmail(email) {
      return (await this.contactsWithEmail(email)).length;
    },
    /** All documents mentioning this email (GHL `query` search), across pages. */
    async documentsForEmail(email, maxPages = 10) {
      const docs = [];
      for (let page = 0; page < maxPages; page++) {
        const r = await client.listDocuments({ query: email, limit: pageSize, skip: docs.length });
        const batch = r?.documents ?? [];
        docs.push(...batch);
        if (!batch.length || docs.length >= (r?.total ?? 0)) break;
      }
      return docs;
    },
    /** Iterate documents created in a window, page by page. */
    async *pages({ dateFrom, dateTo, pageSize, startSkip = 0, status }) {
      let skip = startSkip;
      for (;;) {
        const r = await client.listDocuments({ limit: pageSize, skip, dateFrom, dateTo, status });
        const documents = r?.documents ?? [];
        yield { documents, skip, total: r?.total ?? 0 };
        skip += documents.length;
        if (!documents.length || skip >= (r?.total ?? 0)) return;
      }
    },
    addContactTags: (id, tags) => client.addContactTags(id, tags),
    clearCache: () => contactCache.clear(),
  };
}

export function toCustomerGid(id) {
  if (!id) return null;
  return id.startsWith('gid://') ? id : `gid://shopify/Customer/${id.replace(/\D/g, '')}`;
}
