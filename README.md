# ABM Provider Agreement

This Shopify custom app is for Alpha BioMed Labs. A provider who has signed the **Alpha BioMed Provider Agreement** in GoHighLevel (GHL) checks out normally. An unsigned provider gets a signing popup when they try to check out, and their cart is kept. A checkout Function enforces the same rule on Shopify's servers.

The full brief is in [Antigravity_ABM_Provider_Agreement.md](Antigravity_ABM_Provider_Agreement.md), and the project memory and decisions are in [CLAUDE.md](CLAUDE.md).

| Piece | Where |
|---|---|
| Backend (Node 24, Postgres): sync, webhooks, app proxy, worker, reconciler | [src/](src/) |
| Historical backfill (dry run by default) | [src/backfill/](src/backfill/) |
| Checkout Validation Function (`cart.validations.generate.run`) | [extensions/provider-agreement-validation/](extensions/provider-agreement-validation/) |
| Storefront popup (theme app extension, app embed) | [extensions/provider-agreement-gate/](extensions/provider-agreement-gate/) |
| Render Blueprint | [render.yaml](render.yaml) |

## Commands

```bash
npm ci
npm test                                   # 76 local tests (PGlite Postgres + jsdom; no network)
npm run build                              # syntax check (Render build step)
npm run migrate                            # apply migrations/*.sql
npm start                                  # HTTP + worker + 10-min reconciler

npm run ghl:probe                          # READ-ONLY: diagnose GHL API access (status + GHL's reason)
npm run inspect:identity                   # READ-ONLY: find where GHL/Shopify cross-IDs are stored
npm run backfill                           # DRY RUN: report only, no Shopify writes
npm run backfill -- --resume <runId>       # resume a specific run (failed runs resume automatically)
npm run mapping:import -- reviewed.csv     # import reviewed document IDs (document_id,decision,note)
npm run backfill -- --apply --confirm      # ROLLOUT STEP: write verified signatures to Shopify

npm run setup:metafield                    # create custom.provider_agreement_signed definition
npm run validation -- status|create        # create = installed but DISABLED
npm run validation -- enable --confirm     # ROLLOUT STEP: enforce at checkout
npm run validation -- disable              # rollback
```

Reports are written to `reports/`, which is gitignored. The CSVs contain only IDs and never emails or signing links.

## Manual setup checklist

### Render
- [ ] **New → Blueprint** from this repository. When prompted, enter `APP_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `GHL_PRIVATE_INTEGRATION_TOKEN` and `GHL_LOCATION_ID`. Leave `AGREEMENT_TEMPLATE_ID` and `GHL_SHOPIFY_CUSTOMER_ID_FIELD_ID` blank unless they are verified.
- [ ] Copy the generated `GHL_WEBHOOK_SECRET`, which GHL needs below.
- [ ] Deploy manually (`autoDeploy: false`). Then check that `https://<host>/healthz` returns `{"ok":true}`.
- [ ] Run the backfill CLIs from the Render **Shell**. They use the same env and database.

### Shopify
- [x] The store is on **Shopify Plus** (confirmed), so the checkout Function is allowed.
- [ ] In the Dev Dashboard, create the app under the **same organization** as the store, because the client-credentials grant requires it. Then put the client ID and the Render host into [shopify.app.toml](shopify.app.toml).
- [ ] From the repository root, run `shopify app config link` (browser login, then choose the store's organization and **create a new app**). This overwrites `shopify.app.toml`: restore it with `git checkout shopify.app.toml` and paste in only the new `client_id`.
- [ ] Run `cd extensions/provider-agreement-validation && npm i && shopify app function schema`, then from the root run `shopify app deploy --allow-updates`.
- [ ] Install the app on the store and approve the scopes.
- [ ] Run `npm run setup:metafield`. It creates **Provider agreement signed** (`custom.provider_agreement_signed`, boolean) with customer-account access set to NONE.
- [ ] In the theme editor, go to **App embeds** and turn on **Provider agreement gate**. Test it on a duplicate of the live theme first.
- [ ] Run `npm run validation -- create`, which creates the validation disabled. Enabling it is a later rollout step.
- [x] **Guest policy:** logged-out checkout is blocked (confirmed; `GUEST_POLICY = 'block'`).

### GHL
- [ ] Create a **Private Integration** token for the location. It needs Documents & Contracts read access and Contacts read and write access, because the app reads contacts and adds a recovery tag.
- [ ] Create a workflow named "Provider Agreement → Shopify sync":
  - Trigger: **Documents & Contracts**, Status = Signed/Accepted and Completed, Template = *Alpha BioMed Provider Agreement*, Recipient type = Contact.
  - Action: **Custom Webhook**, POST to `https://<host>/webhooks/ghl/agreement`.
  - Header: `X-ABM-Webhook-Secret: <GHL_WEBHOOK_SECRET>`.
  - JSON body: `{"contact_id":"{{contact.id}}","location_id":"{{location.id}}","document_id":"<document id merge field, if the picker offers one>"}`.
- [ ] Create a recovery workflow. Trigger: **Contact Tag added** `provider-agreement-resend`. Actions: **Send Documents & Contracts** (same template, from Alpha BioMed Support), then remove the tag. Do not change the published `1. Provider Onboarding` workflow.
- [ ] Confirm the agreement template prefills the recipient's first name, last name and email from contact merge fields.

### Rollout, in order and after review
1. [ ] Run `npm run inspect:identity` and set the two ID variables it recommends in Render (or leave them blank if it finds none).
2. [ ] Run `npm run backfill` (dry run). Review `reports/backfill-<id>-dry_run.json` and the CSV.
3. [ ] Fill in the `decision` column of `*-unresolved-review.csv`, run `npm run mapping:import`, then run the dry run again.
4. [ ] Resolve the ambiguous, missing and failed rows in GHL or Shopify, then run the dry run again.
5. [ ] **Apply:** `npm run backfill -- --apply --confirm`.
6. [ ] On a development store or test customers, run the cases in CLAUDE.md under "Needs a dev store". Check embedded signing on desktop and mobile Safari and Chrome.
7. [ ] **Enforce:** `npm run validation -- enable --confirm`. Roll back with `disable`.
