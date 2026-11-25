// npm run backfill:report                    -> latest run
// npm run backfill:report -- --run 2
// npm run backfill:report -- --rename-approver "Your Name" "Real Name"
import { loadConfig } from '../config.js';
import { createPgDb } from '../db.js';
import { renameApprover, runReport } from '../backfill/report.js';

const args = process.argv.slice(2);
const cfg = loadConfig();
const db = createPgDb(cfg.databaseUrl);
try {
  const ri = args.indexOf('--rename-approver');
  if (ri >= 0) {
    const [from, to] = [args[ri + 1], args[ri + 2]];
    if (!from || !to) throw new Error('Usage: --rename-approver "<old>" "<new>"');
    console.log(`Updated ${await renameApprover(db, from, to)} mappings`);
  } else {
    const i = args.indexOf('--run');
    const runId = i >= 0 ? args[i + 1] : (await db.query('SELECT max(id) AS id FROM backfill_runs')).rows[0]?.id;
    if (!runId) throw new Error('No backfill runs yet');
    const r = await runReport(db, runId);
    console.log(`Run ${r.runId}\n\nOutcomes by reason:`);
    console.table(r.byReason);
    if (r.failures.length) {
      console.log('Failure messages:');
      console.table(r.failures);
    }
    console.log(`Rows to review (ambiguous / missing / failed / unusual unresolved), first ${r.review.length}:`);
    console.table(r.review);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
