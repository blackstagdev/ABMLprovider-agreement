import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDocument, evaluateSignatures, pickActiveInvitation } from '../src/domain/agreement.js';
import { matchIdentity, normalizeEmail } from '../src/domain/identity.js';
import { checkoutDecision, isProvider } from '../src/domain/eligibility.js';
import { makeDoc } from './helpers.js';

const cfg = { agreementName: 'Alpha BioMed Provider Agreement', agreementTemplateId: null, requireSignedDate: true };
const verified = { is_agreement: true, source: 'reviewed_import' };

test('name-only match is unresolved, never trusted', () => {
  const d = makeDoc({ contactId: 'c1', email: 'a@x.test', hasCompleted: true, signedDate: '2025-03-02T00:00:00Z' });
  assert.deepEqual(classifyDocument(d, cfg, null), { kind: 'unresolved', reason: 'name_match_only' });
  const ev = evaluateSignatures(d, cfg, null);
  assert.equal(ev.signers[0].outcome, 'unresolved');
});

test('template id on the document identifies the agreement when configured', () => {
  const c = { ...cfg, agreementTemplateId: 'tpl_1' };
  assert.equal(classifyDocument(makeDoc({ contactId: 'c', templateId: 'tpl_1' }), c).kind, 'agreement');
  assert.equal(classifyDocument(makeDoc({ contactId: 'c', templateId: 'tpl_other' }), c).kind, 'not_agreement');
});

test('reviewed mapping identifies or rejects a document', () => {
  const d = makeDoc({ contactId: 'c', name: 'Old provider agreement v1' });
  assert.equal(classifyDocument(d, cfg, verified).kind, 'agreement');
  assert.equal(classifyDocument(d, cfg, { is_agreement: false, source: 'reviewed_import' }).kind, 'not_agreement');
  assert.equal(classifyDocument(makeDoc({ contactId: 'c', name: 'W-9 form' }), cfg, null).kind, 'not_agreement');
});

test('provider signature requires signer role, own completion flag and signed timestamp', () => {
  const signed = makeDoc({ contactId: 'c1', email: 'a@x.test', hasCompleted: true, signedDate: '2025-03-02T10:00:00Z' });
  const ev = evaluateSignatures(signed, cfg, verified);
  assert.equal(ev.signers[0].outcome, 'signed');
  assert.equal(ev.signers[0].signedAt, '2025-03-02T10:00:00.000Z');

  // Sent / opened invitation: not signed.
  const sent = makeDoc({ contactId: 'c1', email: 'a@x.test', status: 'viewed' });
  assert.equal(evaluateSignatures(sent, cfg, verified).signers[0].outcome, 'not_signed');

  // Administrative completion: document status "completed" but the provider recipient did not complete.
  const admin = makeDoc({ contactId: 'c1', email: 'a@x.test', status: 'completed', hasCompleted: false });
  assert.equal(evaluateSignatures(admin, cfg, verified).signers[0].outcome, 'not_signed');

  // Completed but no signed timestamp: routed to review.
  const noDate = makeDoc({ contactId: 'c1', email: 'a@x.test', hasCompleted: true });
  const r = evaluateSignatures(noDate, cfg, verified).signers[0];
  assert.equal(r.outcome, 'unresolved');
  assert.equal(r.reason, 'missing_signed_date');
});

test('business-user signers and CC recipients are not the provider', () => {
  const d = makeDoc({
    contactId: 'c1',
    email: 'a@x.test',
    hasCompleted: false,
    extraRecipients: [
      { id: 'u1', email: 'staff@abm.test', role: 'signer', hasCompleted: true, signedDate: '2025-03-02T00:00:00Z', _entity: 'users' },
      { id: 'c9', email: 'cc@x.test', role: 'signer', hasCompleted: true, signedDate: '2025-03-02T00:00:00Z', _entity: 'contacts', _category: 'cc' },
    ],
  });
  const ev = evaluateSignatures(d, cfg, verified);
  assert.equal(ev.signers.length, 1);
  assert.equal(ev.signers[0].contactId, 'c1');
  assert.equal(ev.signers[0].outcome, 'not_signed');
});

test('document with no contact signer is flagged', () => {
  const d = makeDoc({ contactId: 'c1', role: 'user' });
  assert.equal(evaluateSignatures(d, cfg, verified).problem, 'no_contact_signer');
});

test('active invitation: newest open link, expired and pending states', () => {
  const old = makeDoc({ id: 'old', contactId: 'c1', email: 'a@x.test', createdAt: '2025-01-01T00:00:00Z' });
  const fresh = makeDoc({ id: 'new', contactId: 'c1', email: 'a@x.test', createdAt: '2025-02-01T00:00:00Z' });
  const r = pickActiveInvitation([old, fresh], 'c1', cfg);
  assert.equal(r.status, 'ready');
  assert.equal(r.documentId, 'new');
  assert.match(r.signingUrl, /new\/c1$/);
  assert.equal(pickActiveInvitation([makeDoc({ contactId: 'c1', isExpired: true })], 'c1', cfg).status, 'expired');
  assert.equal(pickActiveInvitation([makeDoc({ contactId: 'c1', status: 'draft' })], 'c1', cfg).status, 'pending_invite');
  assert.equal(pickActiveInvitation([], 'c1', cfg).status, 'not_found');
  // Never returns another contact's link.
  assert.equal(pickActiveInvitation([fresh], 'someone_else', cfg).status, 'not_found');
});

test('identity: stored IDs first, then unique normalized email', () => {
  const cust = { id: 'S1', email: 'a@x.test', ghlContactId: 'c1' };
  assert.deepEqual(matchIdentity({ contactId: 'c1', recipientEmail: 'A@X.test ', shopifyByStoredId: [cust] }).status, 'matched');
  assert.equal(matchIdentity({ contactId: 'c1', recipientEmail: 'a@x.test', shopifyByStoredId: [cust] }).method, 'stored_id');

  const byEmail = matchIdentity({ contactId: 'c1', recipientEmail: 'a@x.test', ghlContactsWithEmail: 1, shopifyByEmail: [{ id: 'S2', email: 'a@x.test' }] });
  assert.equal(byEmail.status, 'matched');
  assert.equal(byEmail.method, 'email');
});

test('identity: collisions, shared practice emails and conflicting IDs go to review', () => {
  const conflict = matchIdentity({ contactId: 'c1', shopifyByStoredId: [{ id: 'S1' }], shopifyByGhlField: { id: 'S2' } });
  assert.deepEqual([conflict.status, conflict.reason], ['ambiguous', 'conflicting_stored_ids']);

  const sharedGhl = matchIdentity({ contactId: 'c1', recipientEmail: 'office@clinic.test', ghlContactsWithEmail: 2, shopifyByEmail: [{ id: 'S1' }] });
  assert.deepEqual([sharedGhl.status, sharedGhl.reason], ['ambiguous', 'shared_email_in_ghl']);

  const sharedShop = matchIdentity({ contactId: 'c1', recipientEmail: 'office@clinic.test', ghlContactsWithEmail: 1, shopifyByEmail: [{ id: 'S1' }, { id: 'S2' }] });
  assert.equal(sharedShop.reason, 'shared_email_in_shopify');

  const linkedElsewhere = matchIdentity({ contactId: 'c1', recipientEmail: 'a@x.test', ghlContactsWithEmail: 1, shopifyByEmail: [{ id: 'S1', ghlContactId: 'c2' }] });
  assert.equal(linkedElsewhere.reason, 'customer_linked_to_other_contact');

  const differs = matchIdentity({ contactId: 'c1', recipientEmail: 'a@x.test', ghlContact: { id: 'c1', email: 'b@x.test' } });
  assert.equal(differs.reason, 'recipient_email_differs_from_contact');

  assert.equal(matchIdentity({ contactId: 'c1', recipientEmail: null }).status, 'missing');
  assert.equal(matchIdentity({ contactId: 'c1', recipientEmail: 'a@x.test', ghlContactsWithEmail: 1, shopifyByEmail: [] }).status, 'missing');
});

test('normalizeEmail handles missing / malformed fields', () => {
  assert.equal(normalizeEmail('  Dr.Smith@Clinic.TEST '), 'dr.smith@clinic.test');
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail(undefined), null);
  assert.equal(normalizeEmail('not-an-email'), null);
});

test('eligibility ignores the pending tag and leaves retail customers alone', () => {
  const tags = ['wholesale'];
  assert.equal(isProvider({ tags: ['provider-agreement-pending'] }, tags), false);
  assert.equal(isProvider({ tags: ['Wholesale'] }, tags), true);
  assert.deepEqual(checkoutDecision({ customer: { tags: [], signed: null }, providerTags: tags }), { allowed: true, reason: 'not_provider' });
  assert.equal(checkoutDecision({ customer: { tags: ['wholesale'], signed: false }, providerTags: tags }).allowed, false);
  assert.equal(checkoutDecision({ customer: { tags: ['wholesale'], signed: null }, providerTags: tags }).allowed, false);
  assert.equal(checkoutDecision({ customer: { tags: ['wholesale'], signed: true }, providerTags: tags }).allowed, true);
  assert.equal(checkoutDecision({ customer: null, providerTags: tags, guestPolicy: 'block' }).allowed, false);
  assert.equal(checkoutDecision({ customer: null, providerTags: tags, guestPolicy: 'allow' }).allowed, true);
});

test('contact id comes from the recipient id, never links[].referenceId (live GHL shape)', () => {
  const d = makeDoc({ contactId: 'contact_abc', email: 'a@x.test' });
  d.links[0].referenceId = 'ref_not_a_contact';
  assert.equal(evaluateSignatures(d, cfg, verified).signers[0].contactId, 'contact_abc');
});
