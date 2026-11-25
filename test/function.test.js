// Checkout Validation Function rule (pure JS; the Wasm build needs Shopify CLI + Javy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cartValidationsGenerateRun as run } from '../extensions/provider-agreement-validation/src/run.js';
import { PROVIDER_TAGS } from '../extensions/provider-agreement-validation/src/policy.js';
import { checkoutDecision } from '../src/domain/eligibility.js';
import { loadConfig } from '../src/config.js';

const input = (step, customer, isAuthenticated = !!customer) => ({ buyerJourney: { step }, cart: { buyerIdentity: { customer, isAuthenticated } } });
const provider = (value) => ({ id: 'gid://shopify/Customer/1', isProvider: true, agreement: value === undefined ? null : { value } });
const errors = (r) => r.operations.flatMap((o) => o.validationAdd?.errors ?? []);

for (const step of ['CHECKOUT_INTERACTION', 'CHECKOUT_COMPLETION']) {
  test(`${step}: unsigned provider (false or missing) is blocked`, () => {
    assert.equal(errors(run(input(step, provider('false')))).length, 1);
    assert.equal(errors(run(input(step, provider(undefined)))).length, 1);
    assert.equal(errors(run(input(step, provider('false'))))[0].target, '$.cart');
  });
  test(`${step}: signed provider and retail customer pass`, () => {
    assert.equal(errors(run(input(step, provider('true')))).length, 0);
    assert.equal(errors(run(input(step, { id: 'x', isProvider: false, agreement: null }))).length, 0);
  });
  test(`${step}: guest policy`, () => {
    assert.equal(errors(run(input(step, null), { guestPolicy: 'block' })).length, 1);
    assert.equal(errors(run(input(step, null), { guestPolicy: 'allow' })).length, 0);
  });
}

test('cart editing stays available (CART_INTERACTION never blocked)', () => {
  assert.deepEqual(run(input('CART_INTERACTION', provider('false'))), { operations: [] });
  assert.deepEqual(run(input('CART_INTERACTION', null)), { operations: [] });
});

test('Function rule matches the server-side rule', () => {
  const tags = PROVIDER_TAGS;
  const cases = [
    { customer: null },
    { customer: { tags: [], signed: null } },
    { customer: { tags: ['wholesale'], signed: true } },
    { customer: { tags: ['wholesale'], signed: false } },
    { customer: { tags: ['wholesale', 'provider-agreement-pending'], signed: null } },
  ];
  for (const c of cases) {
    const fnInput = c.customer
      ? provider(c.customer.signed === null ? undefined : String(c.customer.signed))
      : null;
    if (fnInput && !c.customer.tags.includes('wholesale')) fnInput.isProvider = false;
    const fnAllowed = errors(run(input('CHECKOUT_COMPLETION', fnInput))).length === 0;
    assert.equal(fnAllowed, checkoutDecision({ ...c, providerTags: tags }).allowed, JSON.stringify(c));
  }
});

test('provider tags agree across Function query, Function policy and app default', async () => {
  const gql = await readFile(new URL('../extensions/provider-agreement-validation/src/run.graphql', import.meta.url), 'utf8');
  const tagsInQuery = JSON.parse(gql.match(/hasAnyTag\(tags:\s*(\[[^\]]*\])/)[1]);
  assert.deepEqual(tagsInQuery, PROVIDER_TAGS);
  assert.deepEqual(loadConfig({}).shopify.providerTags, PROVIDER_TAGS);
  assert.match(gql, /namespace: "custom", key: "provider_agreement_signed"/);
});
