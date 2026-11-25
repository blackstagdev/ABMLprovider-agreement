// Minifies storefront/agreement-gate.js into the theme app extension asset.
// Shopify theme check limits app-embed JavaScript to 10 KB. `--check` fails if the asset is stale.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const SRC = new URL('../storefront/agreement-gate.js', import.meta.url);
const OUT = new URL('../extensions/provider-agreement-gate/assets/agreement-gate.js', import.meta.url);
const LIMIT = 10_000;

export async function buildGate() {
  const { code } = await transform(await readFile(SRC, 'utf8'), { minify: true, target: 'es2017', legalComments: 'none' });
  return `/* Generated from storefront/agreement-gate.js by scripts/build-gate.js. Do not edit. */\n${code}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = await buildGate();
  if (Buffer.byteLength(out) > LIMIT) throw new Error(`agreement-gate.js is ${Buffer.byteLength(out)} B (> ${LIMIT} B)`);
  if (process.argv.includes('--check')) {
    const current = await readFile(OUT, 'utf8').catch(() => '');
    if (current !== out) {
      console.error('extensions/provider-agreement-gate/assets/agreement-gate.js is stale. Run: npm run build:gate');
      process.exit(1);
    }
    console.log(`agreement-gate.js up to date (${Buffer.byteLength(out)} B)`);
  } else {
    await writeFile(OUT, out);
    console.log(`Wrote agreement-gate.js (${Buffer.byteLength(out)} B)`);
  }
}
