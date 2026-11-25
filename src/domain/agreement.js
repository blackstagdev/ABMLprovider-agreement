// Pure rules: is a GHL document the provider agreement, and did the provider themself sign it?
//
// GHL's documented List Documents response has no template reference, so agreement identity is
// established (in priority order) by:
//   1. a template ID on the document, if the live API returns one and AGREEMENT_TEMPLATE_ID is set
//   2. a verified document mapping (reviewed import, or a template-filtered GHL workflow event)
// A document that only matches by name is "unresolved" and is never trusted on its own.

export const normalizeName = (s) => (s ?? '').toString().trim().replace(/\s+/g, ' ').toLowerCase();

export function documentId(doc) {
  return doc?.documentId || doc?._id || doc?.id || null;
}

function templateIdOf(doc) {
  return doc?.templateId ?? doc?.template_id ?? doc?.template?._id ?? doc?.template?.id ?? null;
}

/**
 * @returns {{kind: 'agreement'|'unresolved'|'not_agreement', via?: string, reason?: string}}
 */
export function classifyDocument(doc, { agreementName, agreementTemplateId }, mapping) {
  if (!doc || doc.deleted) return { kind: 'not_agreement', reason: 'deleted' };
  const tid = templateIdOf(doc);
  if (agreementTemplateId && tid) {
    return tid === agreementTemplateId
      ? { kind: 'agreement', via: 'template_id' }
      : { kind: 'not_agreement', reason: 'other_template' };
  }
  if (mapping) {
    return mapping.is_agreement
      ? { kind: 'agreement', via: mapping.source }
      : { kind: 'not_agreement', reason: 'mapping_rejected' };
  }
  if (normalizeName(doc.name) === normalizeName(agreementName)) {
    return { kind: 'unresolved', reason: 'name_match_only' };
  }
  return { kind: 'not_agreement', reason: 'name_mismatch' };
}

/** Contact recipients of a document that are signers (excludes business users, CC and BCC). */
export function providerSigners(doc) {
  const recipients = Array.isArray(doc?.recipients) ? doc.recipients : [];
  const links = Array.isArray(doc?.links) ? doc.links : [];
  return recipients
    .filter((r) => r && r.role === 'signer')
    .map((r) => {
      const link = links.find((l) => l && l.recipientId === r.id && !l.deleted);
      return { r, link };
    })
    .filter(({ link }) => !link || (link.entityName === 'contacts' && (link.recipientCategory ?? 'recipient') === 'recipient'))
    .map(({ r, link }) => ({
      recipientId: r.id,
      // Contact recipients: the recipient `id` is the GHL contact id. (Live data 2026-11-26: links[].referenceId
      // is NOT the recipient id, so it is never used as the contact id.)
      contactId: r.contactId || r.id,
      email: r.email || null,
      firstName: r.firstName || null,
      lastName: r.lastName || null,
      hasCompleted: r.hasCompleted === true,
      signedDate: r.signedDate || null,
      shareLink: r.shareLink || null,
      isPrimary: r.isPrimary === true,
    }));
}

const validDate = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Evaluate every provider signer on a document.
 * outcome: 'signed' | 'not_signed' | 'unresolved'
 * A sent invitation, an opened email or document-level "completed" status never counts:
 * only the signer recipient's own completion flag (plus signed timestamp where required).
 */
export function evaluateSignatures(doc, cfg, mapping) {
  const id = documentId(doc);
  const cls = classifyDocument(doc, cfg, mapping);
  if (cls.kind === 'not_agreement') return { documentId: id, classification: cls, signers: [] };

  const signers = providerSigners(doc);
  if (signers.length === 0) {
    return { documentId: id, classification: cls, signers: [], problem: 'no_contact_signer' };
  }
  const out = signers.map((s) => {
    const base = { ...s, documentId: id };
    if (cls.kind === 'unresolved') return { ...base, outcome: 'unresolved', reason: cls.reason, wouldBeSigned: s.hasCompleted };
    if (!s.hasCompleted) return { ...base, outcome: 'not_signed', reason: 'recipient_not_completed' };
    const signedAt = validDate(s.signedDate);
    if (!signedAt && cfg.requireSignedDate) {
      return { ...base, outcome: 'unresolved', reason: 'missing_signed_date' };
    }
    return { ...base, outcome: 'signed', signedAt: (signedAt ?? new Date(doc.updatedAt)).toISOString(), via: cls.via };
  });
  return { documentId: id, classification: cls, signers: out };
}

/**
 * Pick the provider's current signing invitation (for the storefront popup).
 * Prefers a non-expired, non-deleted agreement-candidate where the contact is an incomplete signer.
 */
export function pickActiveInvitation(docs, contactId, cfg, mappings = new Map()) {
  const candidates = [];
  for (const doc of docs) {
    const cls = classifyDocument(doc, cfg, mappings.get(documentId(doc)));
    if (cls.kind === 'not_agreement') continue;
    const signer = providerSigners(doc).find((s) => s.contactId === contactId);
    if (!signer) continue;
    candidates.push({ doc, signer, cls });
  }
  candidates.sort((a, b) => new Date(b.doc.updatedAt || 0) - new Date(a.doc.updatedAt || 0));
  const open = candidates.find((c) => !c.doc.isExpired && !c.signer.hasCompleted && c.doc.status !== 'draft');
  if (open) {
    return open.signer.shareLink
      ? { status: 'ready', documentId: documentId(open.doc), signingUrl: open.signer.shareLink }
      : { status: 'no_link', documentId: documentId(open.doc) };
  }
  if (candidates.some((c) => c.doc.isExpired)) return { status: 'expired' };
  if (candidates.some((c) => c.doc.status === 'draft')) return { status: 'pending_invite' };
  return { status: 'not_found' };
}
