/* Provider agreement checkout gate (theme app embed).
 * - Intercepts checkout attempts (cart page, cart drawer/notification, /checkout links, Buy Now,
 *   accelerated checkout containers) for logged-in providers who are not known to be signed.
 * - Asks the app (via the Shopify app proxy, which authenticates the logged-in customer) for
 *   server-verified status. Only that status unlocks checkout; the checkout Function enforces it.
 * - Opens an accessible modal with the provider's own GHL signing link, polls with bounded backoff,
 *   rechecks on tab return, and resumes the original checkout attempt exactly once.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root && root.document) api.boot(root);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var BACKOFF_SECONDS = [3, 3, 5, 5, 8, 8, 13, 13, 21, 30];
  var MAX_POLL_MS = 20 * 60 * 1000;
  var PENDING_KEY = 'abm-agreement-pending';

  var CHECKOUT_SELECTOR = [
    'button[name="checkout"]',
    'input[name="checkout"]',
    'a[href^="/checkout"]',
    'a[href*="/checkouts/"]',
    'a[href*="/cart/"][href*=":"]', // cart permalinks /cart/VARIANT:QTY
    '.shopify-payment-button__button',
  ].join(',');
  var EXPRESS_SELECTOR = '#dynamic-checkout-cart, .shopify-payment-button, shopify-accelerated-checkout, shopify-accelerated-checkout-cart';

  function backoffDelay(attempt) {
    return BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] * 1000;
  }

  function boot(win, overrides) {
    var doc = win.document;
    var cfgEl = doc.getElementById('abm-agreement-config');
    if (!cfgEl) return null;
    var cfg;
    try {
      cfg = JSON.parse(cfgEl.textContent);
    } catch (e) {
      return null;
    }
    // Retail customers, guests and known-signed providers see the normal checkout experience.
    if (!cfg.enabled || !cfg.loggedIn || !cfg.isProvider || cfg.signedHint) return null;

    var fetchImpl = (overrides && overrides.fetch) || win.fetch.bind(win);
    var navigate = (overrides && overrides.navigate) || function (href) { win.location.assign(href); };
    var t = cfg.text;
    var state = {
      unlocked: false,
      pending: null, // { kind, el, href }
      resumed: false,
      open: false,
      pollTimer: null,
      pollStarted: 0,
      attempt: 0,
      inflight: null,
      returnFocus: null,
      shields: [],
    };

    // ---------- server calls ----------
    function call(path, method) {
      return fetchImpl(cfg.proxyBase + path, {
        method: method || 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    function checkStatus(force) {
      if (state.inflight) return state.inflight;
      state.inflight = call(force ? '/recheck' : '/status', force ? 'POST' : 'GET')
        .then(function (s) {
          state.inflight = null;
          if (s && s.required === false) return { signed: true, notRequired: true };
          return s || { signed: false };
        })
        .catch(function (e) {
          state.inflight = null;
          throw e;
        });
      return state.inflight;
    }

    // ---------- interception ----------
    function classify(target) {
      if (!target || !target.closest) return null;
      if (target.closest('.abm-ag')) return null;
      var shield = target.closest('.abm-ag-shield');
      if (shield) return { kind: 'express', el: shield.parentElement };
      var el = target.closest(CHECKOUT_SELECTOR);
      if (!el) return null;
      if (el.matches('.shopify-payment-button__button')) return { kind: 'buy_now', el: el };
      if (el.tagName === 'A') return { kind: 'link', el: el, href: el.getAttribute('href') };
      return { kind: 'checkout', el: el };
    }

    function onClick(ev) {
      if (state.unlocked) return;
      var hit = classify(ev.target);
      if (!hit) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      begin(hit);
    }

    function onSubmit(ev) {
      if (state.unlocked) return;
      var form = ev.target;
      var submitter = ev.submitter;
      var action = (form && form.getAttribute && form.getAttribute('action')) || '';
      var isCheckout = (submitter && submitter.name === 'checkout') || /\/checkout/.test(action);
      if (!isCheckout) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      begin({ kind: 'checkout', el: submitter || form });
    }

    function shieldExpress() {
      var nodes = doc.querySelectorAll(EXPRESS_SELECTOR);
      for (var i = 0; i < nodes.length; i++) {
        var host = nodes[i];
        if (host.querySelector(':scope > .abm-ag-shield')) continue;
        host.classList.add('abm-ag-shielded');
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'abm-ag-shield';
        b.setAttribute('aria-label', t.shieldLabel);
        host.appendChild(b);
        state.shields.push(b);
      }
    }
    function removeShields() {
      state.shields.forEach(function (b) {
        if (b.parentElement) b.parentElement.classList.remove('abm-ag-shielded');
        b.remove();
      });
      state.shields = [];
    }

    function begin(hit) {
      state.pending = hit;
      state.resumed = false;
      try {
        win.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ kind: hit.kind, href: hit.href || null, path: win.location.pathname, ts: Date.now() }));
      } catch (e) {}
      state.returnFocus = doc.activeElement;
      // Fast path: already signed (server-verified) -> continue immediately, no modal.
      checkStatus(false).then(
        function (s) {
          if (s.signed) unlockAndResume();
          else openModal();
        },
        function () {
          openModal();
        },
      );
    }

    // ---------- resume exactly once ----------
    function unlockAndResume() {
      state.unlocked = true;
      removeShields();
      stopPolling();
      if (state.open) closeModal(false);
      if (state.resumed || !state.pending) return;
      state.resumed = true;
      var p = state.pending;
      state.pending = null;
      try {
        win.sessionStorage.removeItem(PENDING_KEY);
      } catch (e) {}
      if (p.kind === 'link' && p.href) return navigate(p.href);
      if (p.kind === 'express') {
        var buyNow = p.el && p.el.querySelector && p.el.querySelector('.shopify-payment-button__button--unbranded');
        if (buyNow) return buyNow.click();
        // Branded wallets render in shadow DOM / cross-origin frames and can't be clicked for the shopper.
        announce(t.expressUnlocked);
        if (p.el && p.el.focus) p.el.focus();
        return;
      }
      if (p.el && p.el.isConnected) {
        if (p.el.tagName === 'FORM') return p.el.requestSubmit ? p.el.requestSubmit() : p.el.submit();
        return p.el.click();
      }
      navigate('/checkout');
    }

    // ---------- modal ----------
    var modal, dialog, statusEl, frameWrap, frame, whoEl, helpEl, newTabBtn, recheckBtn, continueBtn, requestBtn, supportEl, liveEl;

    function h(tag, attrs, text) {
      var el = doc.createElement(tag);
      for (var k in attrs || {}) el.setAttribute(k, attrs[k]);
      if (text) el.textContent = text;
      return el;
    }

    function build() {
      if (modal) return;
      modal = h('div', { class: 'abm-ag', hidden: '' });
      var overlay = h('div', { class: 'abm-ag__overlay' });
      dialog = h('div', { class: 'abm-ag__dialog color-scheme-1 gradient', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'AbmAgTitle', 'aria-describedby': 'AbmAgIntro', tabindex: '-1' });
      var body = h('div', { class: 'abm-ag__body' });
      body.appendChild(h('h2', { id: 'AbmAgTitle', class: 'abm-ag__title' }, t.title));
      body.appendChild(h('p', { id: 'AbmAgIntro', class: 'abm-ag__intro' }, t.intro));
      whoEl = h('p', { class: 'abm-ag__who', hidden: '' });
      body.appendChild(whoEl);
      frameWrap = h('div', { class: 'abm-ag__frame-wrap', hidden: '' });
      body.appendChild(frameWrap);
      helpEl = h('p', { class: 'abm-ag__help' }, t.loading);
      body.appendChild(helpEl);
      statusEl = h('p', { class: 'abm-ag__status', role: 'status', 'aria-live': 'polite' });
      body.appendChild(statusEl);
      supportEl = h('p', { class: 'abm-ag__support' });
      var email = cfg.supportEmail;
      supportEl.appendChild(doc.createTextNode(t.support + ' '));
      var mail = h('a', { class: 'abm-ag__link', href: 'mailto:' + email }, email);
      supportEl.appendChild(mail);
      supportEl.appendChild(doc.createTextNode('.'));
      body.appendChild(supportEl);

      var actions = h('div', { class: 'abm-ag__actions' });
      continueBtn = h('button', { type: 'button', class: 'button button--secondary' }, t.continueShopping);
      requestBtn = h('button', { type: 'button', class: 'button button--secondary', hidden: '' }, t.requestLink);
      recheckBtn = h('button', { type: 'button', class: 'button button--secondary' }, t.checkAgain);
      newTabBtn = h('a', { class: 'button button--primary', target: '_blank', rel: 'noopener noreferrer', hidden: '' }, t.openNewTab);
      actions.appendChild(continueBtn);
      actions.appendChild(requestBtn);
      actions.appendChild(recheckBtn);
      actions.appendChild(newTabBtn);
      var close = h('button', { type: 'button', class: 'abm-ag__close', 'aria-label': t.continueShopping }, '×');

      dialog.appendChild(close);
      dialog.appendChild(body);
      dialog.appendChild(actions);
      modal.appendChild(overlay);
      modal.appendChild(dialog);
      doc.body.appendChild(modal);

      liveEl = h('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
      liveEl.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
      doc.body.appendChild(liveEl);

      continueBtn.addEventListener('click', cancel);
      close.addEventListener('click', cancel);
      overlay.addEventListener('click', cancel);
      recheckBtn.addEventListener('click', function () { recheck(true); });
      requestBtn.addEventListener('click', requestNewLink);
      newTabBtn.addEventListener('click', function () {
        // They'll sign elsewhere; recheck when they come back (visibilitychange).
        setStatus('');
      });
      modal.addEventListener('keydown', onKeydown);
    }

    function setStatus(text, tone) {
      statusEl.textContent = text || '';
      if (tone) statusEl.setAttribute('data-tone', tone);
      else statusEl.removeAttribute('data-tone');
    }
    function announce(text) {
      if (!liveEl) build();
      liveEl.textContent = '';
      win.setTimeout(function () { liveEl.textContent = text; }, 50);
    }

    function focusables() {
      return Array.prototype.filter.call(
        dialog.querySelectorAll('a[href], button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'),
        function (el) { return !el.hasAttribute('hidden') && !(el.closest('[hidden]')); },
      );
    }
    function onKeydown(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
        return;
      }
      if (ev.key !== 'Tab') return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0];
      var last = f[f.length - 1];
      if (ev.shiftKey && doc.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && doc.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }

    function openModal() {
      build();
      state.open = true;
      modal.removeAttribute('hidden');
      doc.documentElement.classList.add('abm-ag-open');
      dialog.focus();
      setStatus('');
      loadAgreement();
      startPolling();
    }

    function closeModal(restoreFocus) {
      state.open = false;
      stopPolling();
      if (modal) modal.setAttribute('hidden', '');
      doc.documentElement.classList.remove('abm-ag-open');
      if (frame) {
        frame.remove();
        frame = null;
      }
      if (restoreFocus !== false && state.returnFocus && state.returnFocus.focus) state.returnFocus.focus();
    }

    // "Continue shopping": dismiss, cancel the pending checkout attempt, keep the cart untouched.
    function cancel() {
      state.pending = null;
      try {
        win.sessionStorage.removeItem(PENDING_KEY);
      } catch (e) {}
      closeModal(true);
    }

    function loadAgreement() {
      helpEl.textContent = t.loading;
      requestBtn.setAttribute('hidden', '');
      call('/agreement').then(
        function (a) {
          if (!state.open) return;
          if (a.prefill && (a.prefill.firstName || a.prefill.email)) {
            whoEl.textContent = t.signingAs + ' ' + [a.prefill.firstName, a.prefill.lastName].filter(Boolean).join(' ') + (a.prefill.email ? ' (' + a.prefill.email + ')' : '');
            whoEl.removeAttribute('hidden');
          }
          if (a.status === 'ready' && a.signingUrl) {
            frame = h('iframe', { class: 'abm-ag__frame', title: t.title, src: a.signingUrl, referrerpolicy: 'no-referrer', allow: 'clipboard-write' });
            frameWrap.innerHTML = '';
            frameWrap.appendChild(frame);
            frameWrap.removeAttribute('hidden');
            newTabBtn.setAttribute('href', a.signingUrl);
            newTabBtn.removeAttribute('hidden');
            helpEl.textContent = t.frameHelp;
          } else if (a.status === 'pending_invite' || a.status === 'not_found') {
            helpEl.textContent = t.pendingInvite;
            requestBtn.removeAttribute('hidden');
          } else {
            helpEl.textContent = t.expired;
            requestBtn.removeAttribute('hidden');
          }
        },
        function () {
          if (state.open) setStatus(t.error, 'error');
        },
      );
    }

    function requestNewLink() {
      requestBtn.setAttribute('disabled', '');
      call('/resend', 'POST').then(
        function (r) {
          requestBtn.removeAttribute('disabled');
          if (r.status === 'requested') setStatus(t.requested);
          else if (r.status === 'already_requested') setStatus(t.alreadyRequested);
          else setStatus(t.error, 'error');
          if (r.status === 'requested' || r.status === 'already_requested') requestBtn.setAttribute('hidden', '');
        },
        function () {
          requestBtn.removeAttribute('disabled');
          setStatus(t.error, 'error');
        },
      );
    }

    // ---------- polling ----------
    function startPolling() {
      stopPolling();
      state.attempt = 0;
      state.pollStarted = Date.now();
      schedule();
    }
    function stopPolling() {
      if (state.pollTimer) win.clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    function schedule() {
      if (!state.open) return;
      if (Date.now() - state.pollStarted > MAX_POLL_MS) return; // bounded; user can still press "check again"
      state.pollTimer = win.setTimeout(function () {
        recheck(false).then(function () {
          state.attempt++;
          schedule();
        });
      }, backoffDelay(state.attempt));
    }

    // Shows "Confirming your signature…" while the server verifies.
    function recheck(userInitiated) {
      if (!state.open) return Promise.resolve();
      if (userInitiated) setStatus(t.confirming);
      return checkStatus(userInitiated).then(
        function (s) {
          if (s.signed) {
            setStatus(t.confirmed);
            announce(t.confirmed);
            unlockAndResume();
          } else if (userInitiated) {
            setStatus(t.notYet);
          }
        },
        function () {
          if (userInitiated) setStatus(t.error, 'error');
        },
      );
    }

    function onVisibility() {
      if (doc.visibilityState === 'visible' && state.open) {
        setStatus(t.confirming);
        recheck(true);
      }
    }
    // An iframe message (e.g. GHL completion page) may only REQUEST a recheck; it never unlocks.
    function onMessage() {
      if (state.open) recheck(true);
    }

    doc.addEventListener('click', onClick, true);
    doc.addEventListener('submit', onSubmit, true);
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('message', onMessage);
    win.addEventListener('focus', onVisibility);
    shieldExpress();
    // Express buttons render late; shield them as they appear.
    if (win.MutationObserver) {
      new win.MutationObserver(function () {
        if (!state.unlocked) shieldExpress();
      }).observe(doc.body, { childList: true, subtree: true });
    }
    // Returning from a checkout that the Function blocked: /cart?provider_agreement=sign
    if (/[?&]provider_agreement=sign\b/.test(win.location.search)) begin({ kind: 'link', href: '/checkout' });

    return {
      state: state,
      begin: begin,
      cancel: cancel,
      recheck: recheck,
      isOpen: function () { return state.open; },
    };
  }

  return { boot: boot, backoffDelay: backoffDelay, BACKOFF_SECONDS: BACKOFF_SECONDS };
});
