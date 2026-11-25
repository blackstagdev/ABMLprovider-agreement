// Bulk "verified import" for historical agreement documents.
// GHL documents carry no template ID, so the dry run marks every exact-name match as unresolved.
// After the merchant confirms that the exact name "Alpha BioMed Provider Agreement" identifies only
// the provider agreement, this approves every such document from ONE reviewed dry run as
// source 'reviewed_import'. Documents created after that run still need the GHL workflow event
// (or a later reviewed run).
import { normalizeName } from '../domain/agreement.js';

export async function latestDryRun(db) {
  const r = await db.query(`SELECT id FROM backfill_runs WHERE mode = 'dry_run' AND status = 'completed' ORDER BY id DESC LIMIT 1`);
  return r.rows[0]?.id ?? null;
}

/** Counts for the review decision (no writes). */
export async function previewNameMatches(db, runId) {
  const rows = (
    await db.query(
      `SELECT detail->>'reason' AS reason, coalesce(detail->>'signerCompleted', 'n/a') AS signed,
              count(DISTINCT document_id)::int AS documents, count(DISTINCT ghl_contact_id)::int AS contacts
       FROM backfill_records WHERE run_id = $1 AND outcome = 'unresolved'
       GROUP BY 1, 2 ORDER BY 1, 2`,
      [runId],
    )
  ).rows;
  const nameOnly = rows.filter((r) => r.reason === 'name_match_only');
  return {
    runId: String(runId),
    nameMatchDocuments: nameOnly.reduce((n, r) => n + r.documents, 0),
    nameMatchSignedDocuments: nameOnly.filter((r) => r.signed === 'true').reduce((n, r) => n + r.documents, 0),
    nameMatchSignedContacts: nameOnly.filter((r) => r.signed === 'true').reduce((n, r) => n + r.contacts, 0),
    breakdown: rows,
  };
}

/** Write reviewed mappings for every exact-name document in the run. Idempotent. */
export async function approveNameMatches(db, runId, { approvedBy, now = new Date() }) {
  const ids = (
    await db.query(
      `SELECT DISTINCT document_id FROM backfill_records
       WHERE run_id = $1 AND outcome = 'unresolved' AND detail->>'reason' = 'name_match_only'`,
      [runId],
    )
  ).rows.map((r) => r.document_id);
  const note = `bulk exact-name approval of dry run ${runId} by ${approvedBy} on ${now.toISOString().slice(0, 10)}`;
  let written = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const r = await db.query(
      `INSERT INTO document_mappings (document_id, is_agreement, source, note)
       SELECT unnest($1::text[]), true, 'reviewed_import', $2
       ON CONFLICT (document_id) DO NOTHING`,
      [chunk, note],
    );
    written += r.rowCount ?? r.affectedRows ?? 0;
  }
  return { documents: ids.length, newMappings: written, note };
}

/** How many GHL templates carry exactly the agreement name (name is only a safe key if this is 1). */
export async function templatesWithName(ghlClient, agreementName) {
  try {
    const r = await ghlClient.listTemplates({ name: agreementName, limit: 20 });
    const list = r?.data ?? r?.templates ?? [];
    return { ok: true, exact: list.filter((t) => normalizeName(t.name) === normalizeName(agreementName) && !t.deleted).length, total: r?.total ?? list.length };
  } catch (e) {
    return { ok: false, error: `HTTP ${e.status ?? '?'} ${e.ghlReason || ''}`.trim() };
  }
}
