// Checkout enforcement rollout (explicit, separate steps):
//   npm run validation -- status
//   npm run validation -- create              (creates the validation DISABLED)
//   npm run validation -- enable --confirm    (turns enforcement on; blockOnFailure true)
//   npm run validation -- disable             (rollback)
import { loadConfig } from '../config.js';
import { createPgDb } from '../db.js';
import { createShopifyAdmin } from '../shopify/admin.js';

const HANDLE = 'provider-agreement-validation';
const TITLE = 'Provider agreement required';
const [cmd, ...rest] = process.argv.slice(2);

const cfg = loadConfig();
const db = createPgDb(cfg.databaseUrl);
const admin = createShopifyAdmin({ ...cfg.shopify, db });

const find = async () => {
  const d = await admin.graphql(`query { validations(first: 50) { nodes { id title enabled blockOnFailure shopifyFunction { id title apiType } } } }`);
  return d.validations.nodes.find((v) => v.title === TITLE) ?? null;
};
const check = (r) => {
  if (r.userErrors?.length) throw new Error(r.userErrors.map((e) => `${e.code ?? ''} ${e.message}`).join('; '));
  return r.validation;
};

try {
  const current = await find();
  if (cmd === 'status' || !cmd) {
    console.log(current ? JSON.stringify(current, null, 2) : 'Not created yet. Run: npm run validation -- create');
  } else if (cmd === 'create') {
    if (current) console.log('Already exists:', JSON.stringify(current));
    else {
      const d = await admin.graphql(
        `mutation($v: ValidationCreateInput!) { validationCreate(validation: $v) { validation { id title enabled blockOnFailure } userErrors { field message code } } }`,
        { v: { functionHandle: HANDLE, title: TITLE, enable: false, blockOnFailure: true } },
      );
      console.log('Created (disabled):', JSON.stringify(check(d.validationCreate)));
    }
  } else if (cmd === 'enable' || cmd === 'disable') {
    if (!current) throw new Error('Validation not created yet');
    if (cmd === 'enable' && !rest.includes('--confirm')) throw new Error('Enabling blocks unsigned providers at checkout. Re-run with --confirm.');
    const d = await admin.graphql(
      `mutation($id: ID!, $v: ValidationUpdateInput!) { validationUpdate(id: $id, validation: $v) { validation { id title enabled blockOnFailure } userErrors { field message code } } }`,
      { id: current.id, v: { title: TITLE, enable: cmd === 'enable', blockOnFailure: true } },
    );
    console.log(`${cmd}d:`, JSON.stringify(check(d.validationUpdate)));
  } else {
    throw new Error(`Unknown command ${cmd}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
