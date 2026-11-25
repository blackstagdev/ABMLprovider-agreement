# CLAUDE.md: ABM Provider Agreement (project memory)

Read this file at the start of every session. Update it whenever a project decision changes. Brief: [Antigravity_ABM_Provider_Agreement.md](Antigravity_ABM_Provider_Agreement.md). Operator checklist: [README.md](README.md).

## Business rules
- **GHL is the authority for signature evidence. Shopify checkout reads the synced value.**
- Shopify Customer metafield **Provider agreement signed**, `custom.provider_agreement_signed`, `boolean`. Customer-account access is `NONE`. For an in-scope provider, `true` allows checkout and `false` or missing means a signature is required.
- **In-scope provider = a Shopify customer with tag `wholesale`** (`PROVIDER_TAGS`). The theme gates prices and ordering on this tag everywhere. Eligibility never looks at the pending tag.
- Pending tag: `provider-agreement-pending`. The theme export had no existing tag, so this is the proposed default. It is set only on unsigned providers after checking for an existing signature, and removed only after `true` reads back.
- Recovery tag in GHL: `provider-agreement-resend`. A GHL workflow re-sends the agreement. The app never creates documents.
- Retail and non-provider customers are unaffected. **Guests:** the Function blocks logged-out checkout (`GUEST_POLICY='block'`) because the store is provider-only. *This is unconfirmed with the merchant (see Open decisions).*

## Existing GHL setup (do not modify)
- Published workflow **`1. Provider Onboarding`**. Trigger: opportunity enters stage **`Send Document`** in pipeline **`1. Providers (RK)`**. The **`Send Documents & Contracts`** action emails **`Alpha BioMed Provider Agreement`** from **`Alpha BioMed Support`**. It owns document creation and invitations, with a drip delay (`ONBOARDING_DRIP_DELAY_MINUTES`, default 60).
- A separate GHL workflow registers providers as Shopify customers. The app reuses those records. Where it stores cross-IDs is **unverified**. Config assumes Shopify metafield `custom.ghl_contact_id` and optionally a GHL custom field (`GHL_SHOPIFY_CUSTOMER_ID_FIELD_ID`).

## How signatures are verified ([src/domain/agreement.js](src/domain/agreement.js))
- Source: `GET /proposals/document` (header `Version: v3`), paged with `limit`/`skip`/`total`. `dateFrom` and `dateTo` must be sent together.
- **The documented response has no template ID.** Agreement identity, in priority order:
  1. `templateId` on the document, if live data has one and `AGREEMENT_TEMPLATE_ID` is set.
  2. A `document_mappings` row: `reviewed_import` (CSV) or `workflow_event`. A template-filtered GHL workflow posted for that contact's completed document.
  3. A name-only match is **unresolved** and is never trusted.
- Provider signature: a recipient with `role === 'signer'`, linked as `entityName: contacts` and `recipientCategory: recipient`, `hasCompleted === true`, and `signedDate` present (`REQUIRE_SIGNED_DATE`). Document `status` alone, a sent invitation, or a view never counts.
- Recipient `id` is treated as the GHL contact ID (`links[].referenceId` as fallback). **Verify with live data.**
- Signing URL = recipient `shareLink`. The docs only call it "Share link", so **verify that it is recipient-specific and can be framed.**
- GHL has **no marketplace webhook for documents**. The ongoing path is the Documents & Contracts workflow trigger, then a Custom Webhook with header `X-ABM-Webhook-Secret`. Ed25519 `X-GHL-Signature` is also accepted. Legacy RSA `X-WH-Signature` was retired on 2026-09-01. The event payload is only a hint, and the job re-verifies against the API.

## Identity matching ([src/domain/identity.js](src/domain/identity.js))
Order: confirmed link (`customer_links`), then stored IDs (Shopify metafield, GHL custom field), then a normalized email that is unique in **both** GHL and Shopify. Conflicting IDs, shared practice emails, a customer linked to another contact, or a recipient email that differs from the contact email are marked **ambiguous** and go to review. Nothing is applied automatically in those cases.

## Sync invariants ([src/sync/signature-sync.js](src/sync/signature-sync.js))
- All writes for one customer run under `pg_advisory_xact_lock`.
- `true` is written idempotently and read back. Only then is the pending tag removed. If tag removal fails, a `cleanup_tag` job is queued after commit and the reconciler also sweeps.
- `false` is written only by init, with `metafieldsSet` and `compareDigest: null` (create-only). Init re-checks after writing. A late init can never undo `true`.
- `verified_signatures` keeps the **earliest** signature per contact. An older or duplicate unsigned invitation never downgrades it.
- A signature recorded before the customer exists stays unapplied. It is applied on `customers/create` or `customers/update` (init job), or by the reconciler.
- Jobs: Postgres `sync_jobs` with a dedupe key, exponential backoff, max 8 attempts, and stale `running` rows recovered on boot.
- Reconciler (every 10 min, single-flight advisory lock): scans the last `GHL_RECENT_LOOKBACK_DAYS` of documents, applies pending signatures, and cleans stale pending tags.

## Backfill ([src/backfill/run.js](src/backfill/run.js))
- A dry run is the default. It writes only `backfill_runs` and `backfill_records` plus reports, **not** `verified_signatures` (otherwise the live reconciler would apply them).
- Apply needs `--apply --confirm`.
- The upper bound is frozen at run start. Date windows (`BACKFILL_WINDOW_DAYS`) are paged with skip, using a checkpoint `{windowIndex, skip}`. Records are keyed by (run, document, recipient), so restarting is safe. A failed or running run auto-resumes.
- Outcomes: `newly_signed`, `already_signed`, `missing`, `ambiguous`, `unresolved`, `not_signed`, `failed`. `matched` = newly signed + already signed. Counts are reported per contact (best outcome wins) and per record.
- The review loop: `*-unresolved-review.csv` → fill `decision` → `npm run mapping:import` → re-run.

## Storefront
- App proxy `/apps/provider-agreement/*` → `{APP_URL}/proxy/*`. HMAC `signature` and `logged_in_customer_id` are verified, with a 5-minute replay window. A signing URL is only ever returned to the customer it belongs to. Responses are `Cache-Control: no-store`, and logs redact URLs and PII.
- Theme app embed [agreement-gate](extensions/provider-agreement-gate/) intercepts `[name=checkout]`, `/checkout` and `/checkouts/` links, cart permalinks, Buy Now, and shields `#dynamic-checkout-cart`, `.shopify-payment-button` and `shopify-accelerated-checkout*`. It checks server status first, so signed providers see no modal.
- Modal **"Sign your provider agreement"**: iframe plus an always-visible **Open agreement in a new tab** button, **Continue shopping** (cancels the attempt, keeps the cart, restores focus), a focus trap, Esc, and a `role=status` live region. Polling backs off 3s up to 30s and stops after 20 min. It rechecks on focus or visibility. An iframe `message` only *requests* a recheck. On server-verified `signed` the modal closes and the original attempt resumes once. Branded wallets inside shadow DOM or iframes can't be clicked for the shopper, so the modal announces that they should choose again.
- After the Function blocks at checkout, `/cart?provider_agreement=sign` opens the popup.

## Theme findings (read-only reference)
Path: `D:\ABM blackfriday\theme_export__alphabiomedlabs-com-refresh__23NOV2026-0310pm`. Shopify **Refresh 15.1.0** (Dawn family).
- `cart_type: page`. The checkout button is `#checkout[name=checkout]` in `sections/main-cart-footer.liquid`, with `content_for_additional_checkout_buttons` in `#dynamic-checkout-cart`. Also `#CartDrawer-Checkout` (snippets/cart-drawer.liquid) and `cart-notification` `[name=checkout]`.
- `snippets/cart-termsbox.liquid` already greys out checkout (pointer-events none) until a mandatory terms checkbox is ticked. The gate runs after that.
- Buy Now: `{{ form | payment_button }}` in `snippets/buy-buttons.liquid`.
- Guests: `layout/theme.liquid` uses client-side redirects to login on product and collection pages only (the cart redirect is commented out). Prices and ordering are gated on `customer.tags contains 'wholesale'`. Other tags seen: `ABMsalesrep`, `dose`.
- Existing dialogs: `cart-free-gift-popup` (z-index 999999), `cart-upsell-popup`. Our modal uses z-index 2147483000.
- Tokens: fonts Archivo 700 (headings) and Questrial 400 (body). Body scale 105, heading 110. scheme-1 has bg `#ffffff`, text `#122f54`, button `#2861a9`. buttons_radius 40, popup_corner_radius 18, popup border 1, inputs_radius 26. The modal uses the theme's CSS variables and `.button--primary/.button--secondary`.
- The theme also runs Wholesale All-in-One and Klaviyo.

## Architecture
- Node 24 ESM, no framework. `pg`. Admin GraphQL pinned to **2026-10**. Token from the client-credentials grant, cached in `shop_sessions`, or `SHOPIFY_ADMIN_ACCESS_TOKEN`.
- One Render web service runs HTTP, the in-process worker and the reconciler. Render Postgres is `basic-256mb`. `preDeployCommand: npm run migrate`. `/healthz` checks the DB. The service listens on `PORT`.
- Function: JavaScript, `@shopify/shopify_function` 2.0.1, export `cart-validations-generate-run`. Rule logic is in `src/run.js`, which is pure. Tags are hard-coded in `run.graphql` and `policy.js`, and a test keeps them in sync with the `PROVIDER_TAGS` default. Activation: `validationCreate` (disabled), then `validationUpdate enable` with `blockOnFailure: true`.

## Tests
`npm test` runs 67 tests with `node:test`, Postgres via PGlite (real migrations) and jsdom. They need no network or credentials. PGlite prints "The system cannot find the path specified." on Windows, which is harmless.
- **Covered locally:** historical signers, unsigned providers, missing fields, retail unaffected, guest policy, ambiguous identities, duplicate events, signing before customer creation, partial-write retry, delayed init, embedded and new-tab signing UI, direct, Buy Now and express interception, resume once, Function and server rule parity.
- **Needs a dev store or live credentials:** real GHL response shape (`templateId`, `shareLink`, recipient ID = contact ID, `query` search by email), framing of the GHL signing page on the storefront origin (desktop, iOS Safari, Android Chrome), workflow merge fields, `compareDigest:null` behavior, Function compile (Javy) and run in checkout, accelerated checkout coverage, app proxy on the live domain, and client-credentials eligibility.

## Open decisions / to verify
1. Guest policy: is every purchase provider-only (login required)? Default is block.
2. Where the GHL→Shopify registration workflow stores cross-IDs (metafield key, GHL custom field ID).
3. Whether live GHL documents include a template ID. If so, set `AGREEMENT_TEMPLATE_ID` for instant popup unlock. Otherwise unlock waits for the workflow event.
4. Whether `shareLink` is recipient-specific and can be framed (X-Frame-Options/CSP). The new-tab fallback is always present.
5. Store plan (Plus?) and app distribution. **If Functions are unavailable:** keep the sync and popup. Use a public App Store validation app that can block checkout on a customer metafield or tag (the rule is: has `wholesale` AND NOT metafield `true`), or use Shopify's B2B/customer-account requirements. Limits: popup-only enforcement can be bypassed by direct checkout links and wallets.
6. `REQUIRE_SIGNED_DATE=true`. Turn it off only if live completed signers lack `signedDate`.

## Last verified milestone
2026-11-25: full implementation on branch `feature/provider-agreement-sync`, pushed to `origin` = https://github.com/blackstagdev/ABMLprovider-agreement.git (it is the repo's only branch, so it is currently the GitHub default; no `main` yet). 67/67 local tests passing. No GHL/Shopify credentials in this environment. **The real dry-run backfill has NOT been run yet**, because it needs GHL and Shopify credentials.
