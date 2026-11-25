-- Provider agreement app: initial schema.
-- All tables are durable state that must survive Render restarts.

-- Admin API tokens (client-credentials grant tokens expire after ~24h).
CREATE TABLE IF NOT EXISTS shop_sessions (
  shop           TEXT PRIMARY KEY,
  access_token   TEXT NOT NULL,
  scope          TEXT,
  expires_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reviewed / verified mapping of GHL document IDs to "is this the provider agreement?".
-- source: 'reviewed_import' | 'workflow_event' | 'template_id'
CREATE TABLE IF NOT EXISTS document_mappings (
  document_id    TEXT PRIMARY KEY,
  is_agreement   BOOLEAN NOT NULL,
  source         TEXT NOT NULL,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Verified provider signatures from GHL (the signature authority).
-- One row per GHL contact; the earliest verified signature is preserved.
CREATE TABLE IF NOT EXISTS verified_signatures (
  ghl_contact_id   TEXT PRIMARY KEY,
  document_id      TEXT NOT NULL,
  recipient_id     TEXT NOT NULL,
  email_normalized TEXT,
  signed_at        TIMESTAMPTZ NOT NULL,
  verified_via     TEXT NOT NULL,
  shopify_customer_id TEXT,
  applied_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verified_signatures_unapplied
  ON verified_signatures (created_at) WHERE applied_at IS NULL;
CREATE INDEX IF NOT EXISTS verified_signatures_email
  ON verified_signatures (email_normalized);

-- Confirmed identity links between Shopify customers and GHL contacts.
CREATE TABLE IF NOT EXISTS customer_links (
  shopify_customer_id TEXT PRIMARY KEY,
  ghl_contact_id      TEXT NOT NULL UNIQUE,
  method              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Local monotonic view of what we've confirmed in Shopify.
CREATE TABLE IF NOT EXISTS customer_state (
  shopify_customer_id  TEXT PRIMARY KEY,
  signed_confirmed_at  TIMESTAMPTZ,
  initialized_at       TIMESTAMPTZ,
  tag_cleanup_needed   BOOLEAN NOT NULL DEFAULT false,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Durable job queue (sync work, retries, partial-write recovery).
CREATE TABLE IF NOT EXISTS sync_jobs (
  id           BIGSERIAL PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at    TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_dedupe_active
  ON sync_jobs (dedupe_key) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS sync_jobs_claim ON sync_jobs (status, run_at);

-- Backfill runs with resumable checkpoints.
CREATE TABLE IF NOT EXISTS backfill_runs (
  id           BIGSERIAL PRIMARY KEY,
  mode         TEXT NOT NULL,          -- dry_run | apply
  status       TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
  location_id  TEXT NOT NULL,
  upper_bound  TIMESTAMPTZ NOT NULL,   -- fixed at run start so paging is stable
  checkpoint   JSONB NOT NULL DEFAULT '{}'::jsonb,
  counts       JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS backfill_records (
  run_id        BIGINT NOT NULL REFERENCES backfill_runs(id) ON DELETE CASCADE,
  document_id   TEXT NOT NULL,
  recipient_id  TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  ghl_contact_id TEXT,
  shopify_customer_id TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, document_id, recipient_id)
);

-- Deduplicated "send me a fresh agreement link" requests from the storefront.
CREATE TABLE IF NOT EXISTS resend_requests (
  ghl_contact_id TEXT PRIMARY KEY,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL
);

-- Schema bookkeeping.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
