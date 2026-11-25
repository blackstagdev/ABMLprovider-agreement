// Storefront popup behaviour in jsdom, using markup from the Refresh theme's cart page / product form.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// The asset is a classic (non-module) script on the storefront; evaluate it the same way here.
const src = await readFile(new URL('../extensions/provider-agreement-gate/assets/agreement-gate.js', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('module', src)(mod);
const gate = mod.exports;
const locale = JSON.parse(await readFile(new URL('../extensions/provider-agreement-gate/locales/en.default.json', import.meta.url), 'utf8')).gate;
const text = {
  title: locale.title, intro: locale.intro, signingAs: locale.signing_as, openNewTab: locale.open_new_tab, checkAgain: locale.check_again,
  continueShopping: locale.continue_shopping, confirming: locale.confirming, confirmed: locale.confirmed, notYet: locale.not_yet, loading: locale.loading,
  frameHelp: locale.frame_help, pendingInvite: locale.pending_invite, expired: locale.expired, requestLink: locale.request_link, requested: locale.requested,
  alreadyRequested: locale.already_requested, support: locale.support, error: locale.error, expressUnlocked: locale.express_unlocked, shieldLabel: locale.shield_label,
};

// Markup mirrors sections/main-cart-footer.liquid (#checkout, name="checkout") and snippets/buy-buttons.liquid.
const PAGE = `
  <form action="/cart" method="post" id="cart"><button type="submit" id="checkout" class="cart__checkout-button button" name="checkout" form="cart">Check out</button></form>
  <div id="dynamic-checkout-cart"><button id="wallet">Pay</button></div>
  <a id="direct" href="/checkout">Direct checkout</a>
  <a id="other" href="/collections/all">Shop</a>
  <div class="shopify-payment-button"><button class="shopify-payment-button__button shopify-payment-button__button--unbranded" id="buynow">Buy it now</button></div>`;

const windows = [];
after(() => windows.forEach((w) => w.close()));

function setupDom(cfgOverrides = {}, serverStatus = { required: true, signed: false }) {
  const dom = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`, { url: 'https://alphabiomedlabs.com/cart', pretendToBeVisual: true });
  windows.push(dom.window);
  const { window } = dom;
  const cfg = { enabled: true, loggedIn: true, isProvider: true, signedHint: false, proxyBase: '/apps/provider-agreement', supportEmail: 'support@example.test', text, ...cfgOverrides };
  const s = window.document.createElement('script');
  s.type = 'application/json';
  s.id = 'abm-agreement-config';
  s.textContent = JSON.stringify(cfg);
  window.document.body.appendChild(s);

  const server = { status: serverStatus, agreement: { status: 'ready', signingUrl: 'https://docs.example.test/sign/abc', prefill: { firstName: 'Dana', lastName: 'Provider', email: 'dana@clinic.test' } }, calls: [] };
  const fetch = async (url, init = {}) => {
    server.calls.push(`${init.method || 'GET'} ${url}`);
    const body = url.endsWith('/agreement') ? server.agreement : url.endsWith('/resend') ? { status: 'requested' } : server.status;
    return { ok: true, json: async () => body };
  };
  const navigations = [];
  const submits = [];
  window.document.getElementById('cart').addEventListener('submit', (e) => {
    e.preventDefault();
    submits.push(e.submitter?.id);
  });
  window.document.getElementById('direct').addEventListener('click', (e) => e.preventDefault());
  const api = gate.boot(window, { fetch, navigate: (h) => navigations.push(h) });
  return { window, doc: window.document, api, server, navigations, submits };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const click = (win, el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
const modal = (doc) => doc.querySelector('.abm-ag');

test('retail customers, guests and signed providers keep the normal checkout', () => {
  for (const o of [{ isProvider: false }, { loggedIn: false }, { signedHint: true }, { enabled: false }]) {
    const { window, doc, api, submits } = setupDom(o);
    assert.equal(api, null);
    click(window, doc.getElementById('checkout'));
    assert.deepEqual(submits, ['checkout']);
    assert.equal(modal(doc), null);
  }
});

test('server says signed (stale hint): checkout continues without a modal, exactly once', async () => {
  const { window, doc, submits } = setupDom({}, { required: true, signed: true });
  click(window, doc.getElementById('checkout'));
  assert.deepEqual(submits, [], 'held while status is checked');
  await tick(10);
  assert.deepEqual(submits, ['checkout']);
  assert.ok(!modal(doc) || modal(doc).hidden);
});

test('unsigned provider: modal opens titled, focused, with embedded agreement and new-tab fallback', async () => {
  const { window, doc, submits } = setupDom();
  const btn = doc.getElementById('checkout');
  btn.focus();
  click(window, btn);
  await tick(10);
  assert.deepEqual(submits, []);
  const m = modal(doc);
  assert.ok(m && !m.hidden);
  const dialog = m.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(doc.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Sign your provider agreement');
  assert.equal(doc.activeElement, dialog);
  const frame = m.querySelector('iframe');
  assert.equal(frame.getAttribute('src'), 'https://docs.example.test/sign/abc');
  const newTab = [...m.querySelectorAll('a')].find((a) => a.textContent === 'Open agreement in a new tab');
  assert.equal(newTab.getAttribute('target'), '_blank');
  assert.match(newTab.getAttribute('rel'), /noopener/);
  assert.match(m.textContent, /Signing as Dana Provider \(dana@clinic\.test\)/);
  assert.ok(m.querySelector('[role="status"][aria-live="polite"]'));
});

test('Continue shopping dismisses, cancels the attempt, preserves the cart and restores focus', async () => {
  const { window, doc, api, submits, server } = setupDom();
  const btn = doc.getElementById('checkout');
  btn.focus();
  click(window, btn);
  await tick(10);
  const cont = [...modal(doc).querySelectorAll('button')].find((b) => b.textContent === 'Continue shopping');
  click(window, cont);
  assert.ok(modal(doc).hidden);
  assert.equal(doc.activeElement, btn);
  assert.equal(api.state.pending, null);
  // Even if the signature is confirmed later, the cancelled checkout is not resumed.
  server.status = { required: true, signed: true };
  await api.recheck(true);
  assert.deepEqual(submits, []);
  assert.ok(!server.calls.some((c) => /cart\/(clear|change)/.test(c)), 'cart untouched');
});

test('Escape closes; Tab is trapped inside the dialog', async () => {
  const { window, doc } = setupDom();
  click(window, doc.getElementById('checkout'));
  await tick(10);
  const m = modal(doc);
  const focusables = [...m.querySelectorAll('a[href], button:not([disabled]), iframe')].filter((el) => !el.closest('[hidden]') && !el.hasAttribute('hidden'));
  focusables.at(-1).focus();
  m.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, focusables[0]);
  focusables[0].focus();
  m.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, focusables.at(-1));
  m.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.ok(m.hidden);
});

test('server-verified signature closes the popup and resumes the original checkout exactly once', async () => {
  const { window, doc, api, server, submits } = setupDom();
  click(window, doc.getElementById('checkout'));
  await tick(10);
  // An iframe message alone cannot unlock: server still says unsigned.
  window.dispatchEvent(new window.MessageEvent('message', { data: { signed: true }, origin: 'https://evil.test' }));
  await tick(10);
  assert.deepEqual(submits, []);
  assert.match(modal(doc).querySelector('.abm-ag__status').textContent, /haven't received/);

  // Shopper returns to the tab after signing in a new tab -> recheck shows "Confirming…" then unlocks.
  server.status = { required: true, signed: true };
  const p = api.recheck(true);
  assert.equal(modal(doc).querySelector('.abm-ag__status').textContent, 'Confirming your signature…');
  await p;
  await api.recheck(true);
  window.dispatchEvent(new window.Event('focus'));
  await tick(10);
  assert.deepEqual(submits, ['checkout'], 'resumed once');
  assert.ok(modal(doc).hidden);
  assert.ok(server.calls.includes('POST /apps/provider-agreement/recheck'));
});

test('direct /checkout links resume by navigating to the original href', async () => {
  const { window, doc, server, navigations } = setupDom();
  click(window, doc.getElementById('direct'));
  await tick(10);
  assert.ok(!modal(doc).hidden);
  server.status = { required: true, signed: true };
  click(window, [...modal(doc).querySelectorAll('button')].find((b) => b.textContent.startsWith("I've signed")));
  await tick(10);
  assert.deepEqual(navigations, ['/checkout']);
});

test('non-checkout links are untouched', () => {
  const { window, doc, api } = setupDom();
  let preventedBeforeBubble = null;
  doc.addEventListener('click', (e) => {
    preventedBeforeBubble = e.defaultPrevented; // what the gate's capture listener left behind
    e.preventDefault(); // jsdom can't navigate
  });
  doc.getElementById('other').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(preventedBeforeBubble, false);
  assert.equal(api.state.pending, null);
});

test('express/Buy Now containers are shielded; Buy Now resumes after verification', async () => {
  const { window, doc, server } = setupDom();
  const shields = doc.querySelectorAll('.abm-ag-shield');
  assert.equal(shields.length, 2, 'cart wallets + product Buy Now');
  let bought = 0;
  doc.getElementById('buynow').addEventListener('click', () => bought++);
  click(window, doc.querySelector('.shopify-payment-button .abm-ag-shield'));
  await tick(10);
  assert.equal(bought, 0);
  assert.ok(!modal(doc).hidden);
  server.status = { required: true, signed: true };
  click(window, [...modal(doc).querySelectorAll('button')].find((b) => b.textContent.startsWith("I've signed")));
  await tick(10);
  assert.equal(bought, 1);
  assert.equal(doc.querySelectorAll('.abm-ag-shield').length, 0);
});

test('expired link offers a recovery request and shows support contact', async () => {
  const { window, doc, server } = setupDom();
  server.agreement = { status: 'expired', prefill: {} };
  click(window, doc.getElementById('checkout'));
  await tick(10);
  const m = modal(doc);
  assert.equal(m.querySelector('iframe'), null);
  const req = [...m.querySelectorAll('button')].find((b) => b.textContent === 'Email me a new agreement link');
  assert.ok(!req.hidden);
  click(window, req);
  await tick(10);
  assert.match(m.querySelector('.abm-ag__status').textContent, /Request received/);
  assert.equal(m.querySelector('a[href^="mailto:"]').getAttribute('href'), 'mailto:support@example.test');
});

test('polling uses bounded backoff', () => {
  assert.equal(gate.backoffDelay(0), 3000);
  assert.equal(gate.backoffDelay(5), 8000);
  assert.equal(gate.backoffDelay(500), 30000);
});

test('shipped asset is the current minified build and under the 10 KB theme-check limit', async () => {
  const { buildGate } = await import('../scripts/build-gate.js');
  const expected = await buildGate();
  assert.equal(src, expected, 'run npm run build:gate');
  assert.ok(Buffer.byteLength(src) <= 10_000);
});
