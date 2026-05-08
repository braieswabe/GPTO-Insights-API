-- Dashboard API cache and refresh jobs tables
-- This migration expects the `sites` and `users` tables to already exist.
-- It is idempotent: safe to run repeatedly even if parts were applied before.

CREATE TABLE IF NOT EXISTS dashboard_api_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NULL REFERENCES sites(id) ON DELETE CASCADE,
  portal_scope varchar(40) NOT NULL DEFAULT 'employee',
  module_key varchar(120) NOT NULL,
  range_key varchar(40) NOT NULL DEFAULT '7d',
  params_hash varchar(128) NOT NULL,
  payload jsonb NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'ready',
  generated_at timestamp NOT NULL DEFAULT now(),
  source_watermark_at timestamp NULL,
  expires_at timestamp NULL,
  error text NULL,
  model_version varchar(80) NOT NULL DEFAULT 'gpto.dashboard.insights.v2',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Add columns that may be missing if the table was created by an older migration
ALTER TABLE dashboard_api_cache ADD COLUMN IF NOT EXISTS portal_scope varchar(40) NOT NULL DEFAULT 'employee';
ALTER TABLE dashboard_api_cache ADD COLUMN IF NOT EXISTS model_version varchar(80) NOT NULL DEFAULT 'gpto.dashboard.insights.v2';
ALTER TABLE dashboard_api_cache ADD COLUMN IF NOT EXISTS source_watermark_at timestamp NULL;

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_api_cache_unique_idx
ON dashboard_api_cache (
  portal_scope,
  module_key,
  COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
  range_key,
  params_hash,
  model_version
);

CREATE INDEX IF NOT EXISTS dashboard_api_cache_lookup_idx
ON dashboard_api_cache (portal_scope, module_key, site_id, range_key, generated_at DESC);

CREATE INDEX IF NOT EXISTS dashboard_api_cache_expiry_idx
ON dashboard_api_cache (status, expires_at);

CREATE TABLE IF NOT EXISTS dashboard_refresh_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NULL REFERENCES sites(id) ON DELETE CASCADE,
  portal_scope varchar(40) NOT NULL DEFAULT 'employee',
  module_key varchar(120) NOT NULL,
  range_key varchar(40) NOT NULL DEFAULT '7d',
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  params_hash varchar(128) NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'pending',
  priority integer NOT NULL DEFAULT 100,
  attempts integer NOT NULL DEFAULT 0,
  locked_by varchar(120) NULL,
  locked_at timestamp NULL,
  requested_by uuid NULL,
  requested_at timestamp NOT NULL DEFAULT now(),
  started_at timestamp NULL,
  finished_at timestamp NULL,
  error text NULL,
  model_version varchar(80) NOT NULL DEFAULT 'gpto.dashboard.insights.v2',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Add ALL columns that may be missing if the table was created by an older migration
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS site_id uuid NULL;
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS portal_scope varchar(40) NOT NULL DEFAULT 'employee';
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS module_key varchar(120) NOT NULL DEFAULT '';
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS range_key varchar(40) NOT NULL DEFAULT '7d';
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS params_hash varchar(128) NOT NULL DEFAULT '';
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS status varchar(40) NOT NULL DEFAULT 'pending';
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100;
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS locked_by varchar(120) NULL;
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS locked_at timestamp NULL;
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS requested_by uuid NULL;
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS requested_at timestamp NOT NULL DEFAULT now();
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS started_at timestamp NULL;
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS finished_at timestamp NULL;
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS error text NULL;
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS model_version varchar(80) NOT NULL DEFAULT 'gpto.dashboard.insights.v2';
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now();
ALTER TABLE dashboard_refresh_jobs ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_refresh_jobs_pending_unique_idx
ON dashboard_refresh_jobs (
  portal_scope,
  module_key,
  COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
  range_key,
  params_hash,
  model_version
)
WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS dashboard_refresh_jobs_claim_idx
ON dashboard_refresh_jobs (status, priority ASC, requested_at ASC);

CREATE INDEX IF NOT EXISTS dashboard_refresh_jobs_key_history_idx
ON dashboard_refresh_jobs (
  portal_scope, module_key, site_id, range_key, params_hash, model_version, requested_at DESC
);

-- Performance indexes on source tables
CREATE INDEX IF NOT EXISTS dashboard_rollups_daily_site_day_desc_idx
ON dashboard_rollups_daily (site_id, day DESC);

CREATE INDEX IF NOT EXISTS authority_signals_site_window_created_idx
ON authority_signals (site_id, window_start, window_end, created_at DESC);

CREATE INDEX IF NOT EXISTS experience_signals_site_window_created_idx
ON experience_signals (site_id, window_start, window_end, created_at DESC);

CREATE INDEX IF NOT EXISTS search_signals_site_window_created_idx
ON search_signals (site_id, window_start, window_end, created_at DESC);

CREATE INDEX IF NOT EXISTS confusion_signals_site_window_created_idx
ON confusion_signals (site_id, window_start, window_end, created_at DESC);

CREATE INDEX IF NOT EXISTS coverage_signals_site_window_created_idx
ON coverage_signals (site_id, window_start, window_end, created_at DESC);

CREATE INDEX IF NOT EXISTS journey_signals_site_window_created_idx
ON journey_signals (site_id, window_start, window_end, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_mentions_snapshots_site_endpoint_status_fetched_idx
ON llm_mentions_snapshots (site_id, endpoint, status, fetched_at DESC);

CREATE INDEX IF NOT EXISTS llm_mentions_prompt_observations_site_source_fetched_idx
ON llm_mentions_prompt_observations (site_id, source, fetched_at DESC);

CREATE INDEX IF NOT EXISTS llm_mentions_rollups_daily_site_type_source_day_idx
ON llm_mentions_rollups_daily (site_id, rollup_type, source, day DESC);
