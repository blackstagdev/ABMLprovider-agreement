// Review summary for a backfill run, read from the database (works on Render without downloading files).
// Prints IDs only (GHL document/contact, Shopify customer): no emails or names.

export async function runReport(db, runId, { listLimit = 200 } = {}) {
  const byReason = (
    await db.query(
      `SELECT outcome, coalesce(detail->>'reason', detail->>'method', '') AS reason,
              count(*)::int AS records, count(DISTINCT coalesce(ghl_contact_id, document_id))::int AS contacts
       FROM backfill_records WHERE run_id = $1 GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
      [runId],
    )
  ).rows;
  const failures = (
    await db.query(
      `SELECT left(regexp_replace(detail->>'error', '[^\\s@]+@[^\\s@]+', '[email]', 'g'), 160) AS error, count(*)::int AS n
       FROM backfill_records WHERE run_id = $1 AND outcome = 'failed' GROUP BY 1 ORDER BY 2 DESC`,
      [runId],
    )
  ).rows;
  const review = (
    await db.query(
      `SELECT outcome, coalesce(detail->>'reason', detail->>'error', '') AS reason, document_id, ghl_contact_id, shopify_customer_id
       FROM backfill_records
       WHERE run_id = $1 AND outcome IN ('ambiguous', 'missing', 'failed')
          OR run_id = $1 AND outcome = 'unresolved' AND coalesce(detail->>'reason', '') <> 'no_contact_signer'
       ORDER BY outcome, reason, ghl_contact_id LIMIT $2`,
      [runId, listLimit],
    )
  ).rows.map((r) => ({ ...r, reason: r.reason.replace(/[^\s@]+@[^\s@]+/g, '[email]').slice(0, 120) }));
  return { runId: String(runId), byReason, failures, review };
}

/** Correct the approver recorded on bulk mappings (e.g. a placeholder name was used). */
export async function renameApprover(db, from, to) {
  const r = await db.query(
    `UPDATE document_mappings SET note = replace(note, $1, $2), updated_at = now()
     WHERE source = 'reviewed_import' AND note LIKE '%' || $1 || '%'`,
    [` by ${from} on `, ` by ${to} on `],
  );
  return r.rowCount ?? r.affectedRows ?? 0;
}
