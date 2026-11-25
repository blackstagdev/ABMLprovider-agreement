// npm run mapping:approve-names                          -> preview latest dry run (no writes)
// npm run mapping:approve-names -- --run 1               -> preview a specific run
// npm run mapping:approve-names -- --run 1 --confirm --by "Name"  -> write reviewed mappings
// After confirming, re-run `npm run backfill` (dry run) to see real matched/signed counts.
import { loadConfig } from '../config.js';
import { createPgDb } from '../db.js';
import { createGhlClient } from '../ghl/client.js';
import { approveNameMatches, latestDryRun, previewNameMatches, templatesWithName } from '../backfill/approve.js';

const args = process.argv.slice(2);
const arg = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};
const cfg = loadConfig();
const db = createPgDb(cfg.databaseUrl);
try {
  const runId = arg('--run') ?? (await latestDryRun(db));
  if (!runId) throw new Error('No completed dry run found. Run: npm run backfill');
  const preview = await previewNameMatches(db, runId);
  const ghl = createGhlClient({ token: cfg.ghl.token, locationId: cfg.ghl.locationId });
  const templates = await templatesWithName(ghl, cfg.ghl.agreementName);
  console.log(JSON.stringify({ agreementName: cfg.ghl.agreementName, ...preview, ghlTemplatesWithExactName: templates }, null, 2));

  if (!args.includes('--confirm')) {
    console.log('\nPreview only. To approve these documents as the provider agreement:');
    console.log(`  npm run mapping:approve-names -- --run ${runId} --confirm --by "<your name>"`);
  } else {
    const by = arg('--by');
    if (!by) throw new Error('--by "<your name>" is required with --confirm (recorded on each mapping)');
    if (templates.ok && templates.exact > 1) throw new Error(`${templates.exact} GHL templates share this exact name; the name is not a safe key. Review document IDs instead.`);
    const r = await approveNameMatches(db, runId, { approvedBy: by });
    console.log(`\nApproved ${r.documents} documents (${r.newMappings} new mappings). Next: npm run backfill`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
