// npm run backfill                      -> dry run (default, no Shopify writes)
// npm run backfill -- --apply --confirm  -> apply verified signatures to Shopify
// npm run backfill -- --resume <runId>   -> resume a specific run
import { buildServices } from '../services.js';
import { runBackfill } from './run.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirm = args.includes('--confirm');
const resumeIdx = args.indexOf('--resume');
const resumeRunId = resumeIdx >= 0 ? Number(args[resumeIdx + 1]) : null;

if (apply && !confirm) {
  console.error('Refusing to write to Shopify: add --confirm after reviewing the dry-run report.');
  process.exit(2);
}

const s = await buildServices({ needShopify: true, needGhl: true });
try {
  const result = await runBackfill({
    ...s,
    mode: apply ? 'apply' : 'dry_run',
    resumeRunId,
    onProgress: (p) => process.stdout.write(`\rwindow ${p.windowIndex + 1}/${p.windows} skip ${p.skip}   `),
  });
  console.log('\n' + JSON.stringify({ runId: result.runId, mode: result.mode, summary: result.summary, reports: result.files }, null, 2));
} finally {
  await s.db.close();
}
