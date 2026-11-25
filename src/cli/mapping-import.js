// npm run mapping:import -- review/reviewed.csv
// Imports a reviewed list of GHL document IDs. CSV columns: document_id,decision[,note]
// decision: "agreement" (counts as the Alpha BioMed Provider Agreement) or "not_agreement".
// Start from the backfill's *-unresolved-review.csv and fill in the decision column.
import { readFile } from 'node:fs/promises';
import { createPgDb } from '../db.js';
import { parseCsv } from '../csv.js';
import { repo } from '../sync/repo.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run mapping:import -- <reviewed.csv>');
  process.exit(2);
}
const rows = parseCsv(await readFile(file, 'utf8'));
const db = createPgDb(process.env.DATABASE_URL);
const counts = { agreement: 0, not_agreement: 0, skipped: 0 };
try {
  for (const r of rows) {
    const decision = (r.decision ?? '').trim().toLowerCase();
    if (!r.document_id || !['agreement', 'not_agreement'].includes(decision)) {
      counts.skipped++;
      continue;
    }
    await repo.upsertMapping(db, { documentId: r.document_id.trim(), isAgreement: decision === 'agreement', source: 'reviewed_import', note: r.note || null });
    counts[decision]++;
  }
  console.log(JSON.stringify(counts));
} finally {
  await db.close();
}
