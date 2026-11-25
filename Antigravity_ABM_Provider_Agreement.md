# Build the Alpha BioMed provider agreement checkout app

Build, test, commit, and push a working Shopify custom app for Alpha BioMed Labs. Make the backend deployable on Render from the Git repository. A provider who has already signed our agreement should go straight to checkout. An unsigned provider should be prompted to sign when they try to check out, with their name, email, and cart preserved. Start with historical signature reconciliation so existing signers are recognized before enforcement goes live.

## Work with our existing setup

- A separate GoHighLevel (GHL) workflow already registers providers as Shopify customers. Reuse those customer records and the existing identity mapping.
- The published GHL workflow `1. Provider Onboarding` starts when an opportunity enters `Send Document` in the `1. Providers (RK)` pipeline. Its `Send Documents & Contracts` action emails the `Alpha BioMed Provider Agreement` directly from `Alpha BioMed Support`. That workflow owns document creation and invitation emails. Opening the storefront popup must reuse the provider’s existing agreement.
- Scope this app to that agreement and to providers covered by it. Inspect how the existing integration identifies an individual provider. Keep that eligibility rule independent of the temporary pending tag. Confirm the guest policy before enabling enforcement, especially if the store also serves retail customers.
- Inspect the current theme export at `D:\ABM blackfriday\theme_export__alphabiomedlabs-com-refresh__23NOV2026-0310pm`. Use it as a read-only design and integration reference. Keep the app in its own repository and ship the storefront UI as a Shopify theme app extension. If this directory is unavailable in your environment, flag which theme details still need verification and continue the backend work.

## 1. Backfill historical signatures first

Define a Shopify **Customer** metafield named **Provider agreement signed**, key `custom.provider_agreement_signed`, type `boolean`. GHL is the authority for signature evidence. Shopify checkout reads the synchronized value. For an in-scope provider, `true` allows checkout and `false` or missing means a signature is required. Keep customer write access to this field disabled.

Build a resumable backfill with a default dry run and an explicit apply command. Page through the full history for the configured GHL location. Verify the correct agreement and the provider’s own signature using the recipient role, identity, completion flag, and signed timestamp where available. A sent invitation, opened email, or administrative completion alone is insufficient. Prefer a stable template identifier or verified document-to-template mapping. If historical records lack that link, support a reviewed list of document IDs or a verified import and report unresolved records.

Match the GHL contact to an existing Shopify customer using the stored cross-platform IDs first. Use a normalized email only when it uniquely identifies the same person on both sides. Route collisions, shared practice emails, and conflicting IDs to review. Report matched, already signed, newly signed, missing, ambiguous, and failed records. Applying or restarting a run must be safe while new signatures arrive. Preserve a verified signature when an older or duplicate invitation appears.

## 2. Keep Shopify current after the backfill

Add a verified server-side completion path for the same GHL location, agreement, and provider. Use an officially supported event, or a template-filtered GHL **Documents & Contracts** workflow posting to an authenticated endpoint. Verify the signer against GHL before granting access. Handle signing from the existing email, the Shopify popup, or another device. Reconcile missed events and signatures received before the Shopify customer is created.

Initialize an unsigned provider with `false` and the configured pending tag after checking for an existing signature. Reuse the merchant’s existing tag, or propose `provider-agreement-pending` if none exists. On verified signing, set the boolean to `true`, then remove only that pending tag. Make updates idempotent, retry partial writes, and ensure a delayed initialization or tag cleanup cannot undo verified access.

## 3. Enforce checkout and build the signing popup

Shopify currently requires Plus for Functions in custom apps. Verify the store’s plan and app distribution. On an eligible store, implement a **Cart and Checkout Validation Function** that reads the provider’s Shopify state and blocks an unsigned provider from completing checkout. Keep cart editing available. Cover direct checkout links, Buy Now, and supported accelerated checkouts. Establish how a protected purchase is identified when a shopper is logged out. If the same cart is available to anonymous retail buyers, flag that identity gap and confirm which purchases require login. If custom Functions are unavailable, keep the sync and popup installable, identify a compatible public validation app or another documented option that enforces the same rule, and report any limits. Enable enforcement only once the server-side rule has been tested.

Inspect the exported theme’s cart page, AJAX cart drawer, product buttons, CSS variables, and existing dialogs. On a protected checkout attempt, open a modal titled **Sign your provider agreement**. Match the theme’s type, colors, buttons, and spacing. Use a centered desktop dialog and a scrollable mobile layout with reachable controls. Provide keyboard navigation, visible focus, focus restoration, and an accessible status announcement. **Continue shopping** should dismiss the modal, cancel the pending checkout attempt, and preserve the cart. Signed providers should see the normal checkout experience.

Authenticate storefront requests through Shopify. Resolve the signed-in Shopify customer to the same GHL recipient, reuse their active recipient-specific signing URL, and prefill their first name, last name, and email through supported GHL recipient or merge fields. Test embedded signing on the storefront origin in desktop and mobile browsers. If framing is unsupported, offer **Open agreement in a new tab** in the same modal. Account for the onboarding workflow’s drip delay. For a missing or expired invitation, provide a recovery action coordinated with that workflow, deduplicate requests, and show a support contact if a fresh link cannot be issued. Keep signing URLs private to their intended recipient.

While the modal is open, poll the app for that customer’s status with bounded backoff and recheck when the shopper returns to the tab. Show **Confirming your signature…** while syncing. Once the backend verifies the signature and confirms the Shopify write, automatically close the popup, enable checkout, and resume the original checkout attempt exactly once. A browser click, redirect, or iframe message can request a recheck. Only server-verified status can unlock the purchase.

## 4. Deliver a deployable repository

- Use the current supported Shopify app tooling, a pinned Admin GraphQL API version, and durable PostgreSQL storage for sessions, sync jobs, document mappings, and backfill checkpoints. Authenticate inbound events using the mechanism supported by each sender. Keep credentials, real customer records, and signer URLs out of Git and logs.
- Include a root `render.yaml` Blueprint, database migrations, health endpoint, `.env.example` with placeholders, and repeatable build/start commands. Listen on Render’s assigned port and persist sync progress across restarts. Document how to release the web service on Render and the app configuration, theme extension, and eligible Function on Shopify.
- Create a root `CLAUDE.md` as project memory. Record the business rules, exact GHL workflow and template, Shopify field and tag conventions, theme path and findings, architecture, sync rules, commands, deployment process, tests, unresolved decisions, and last verified milestone. Read it at the start of future sessions and update it whenever a project decision changes.
- Test historical signers, unsigned providers, missing fields, unaffected retail customers, guest access, ambiguous identities, duplicate events, signing before customer creation, embedded and hosted signing, direct and accelerated checkout, and automatic return to the original cart. Distinguish local test results from cases that require a development store or live credentials.
- Commit the implementation and push a feature branch to the authorized Git remote. If a remote or credentials are missing, complete and commit the local work and identify the access needed to push. Return the branch, commit, test results, and a concise README checklist of the manual Shopify, GHL, and Render tasks that remain for me. Make production backfill writes and checkout activation explicit rollout actions after review of the dry-run results.

Use the current official documentation to verify the implementation.

- [Shopify Functions eligibility](https://shopify.dev/docs/apps/build/functions) and [cart and checkout validation](https://shopify.dev/docs/api/functions/latest/cart-and-checkout-validation)
- [HighLevel document and recipient fields](https://marketplace.gohighlevel.com/docs/ghl/proposals/list-documents-contracts/) and [document status workflow triggers](https://help.gohighlevel.com/support/solutions/articles/155000001491)
- [Shopify extension releases](https://shopify.dev/docs/apps/launch/deployment/deploy-app-versions) and [Render Blueprint reference](https://render.com/docs/blueprint-spec)
