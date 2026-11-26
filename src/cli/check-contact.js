// npm run check:contact -- <GHL contact ID>
// READ-ONLY. Explains why a GHL contact is or isn't treated as signed: how its documents are found
// (email search vs date scan), each document's evaluation, and what the database holds.
// Prints IDs, counts and yes/no flags only: no names or emails.
import { buildServices } from '../services.js';
import { documentId } from '../domain/agreement.js';

const contactId = process.argv[2];
if (!contactId) {
  console.error('Usage: npm run check:contact -- <GHL contact ID>');
  process.exit(1);
}
const { db, ghl, sync } = await buildServices();
try {
  const contact = await ghl.getContact(contactId);
  const out = { contactId, contactFound: !!contact, contactHasEmail: !!contact?.email };
  if (contact?.email) {
    const searched = await ghl.documentsForEmail(contact.email);
    out.emailSearch = {
      documentsReturned: searched.length,
      withThisContactAsRecipient: searched.filter((d) => (d.recipients ?? []).some((r) => (r.contactId || r.id) === contactId)).length,
    };
  }
  const docs = await sync.documentsForContact(contactId, contact?.email);
  out.documentsFoundVia = docs.via;
  out.documents = (await sync.evaluateDocs(db, docs)).map((ev) => {
    const d = docs.find((x) => documentId(x) === ev.documentId);
    const r = (d?.recipients ?? []).find((x) => (x.contactId || x.id) === contactId) ?? {};
    const s = ev.signers.find((x) => x.contactId === contactId);
    return {
      documentId: ev.documentId,
      createdAt: d?.createdAt ?? d?.dateCreated ?? null,
      status: d?.status ?? null,
      isAgreement: ev.classification.kind,
      via: ev.classification.via ?? ev.classification.reason ?? null,
      recipientRole: r.role ?? null,
      hasCompleted: r.hasCompleted ?? null,
      hasSignedDate: !!r.signedDate,
      outcome: s?.outcome ?? ev.problem ?? null,
      reason: s?.reason ?? null,
    };
  });
  const q = async (sql) => (await db.query(sql, [contactId])).rows;
  out.database = {
    backfillRecords: await q(
      `SELECT run_id, outcome, coalesce(detail->>'reason', detail->>'method', '') AS reason, document_id, shopify_customer_id
       FROM backfill_records WHERE ghl_contact_id = $1 ORDER BY run_id DESC, document_id LIMIT 20`,
    ),
    verifiedSignature: (await q('SELECT document_id, signed_at, applied_at, shopify_customer_id FROM verified_signatures WHERE ghl_contact_id = $1'))[0] ?? null,
    linkedShopifyCustomer: (await q('SELECT shopify_customer_id, method FROM customer_links WHERE ghl_contact_id = $1'))[0] ?? null,
  };
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
