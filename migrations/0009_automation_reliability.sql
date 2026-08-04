ALTER TABLE dashboard_refresh_jobs
ADD COLUMN IF NOT EXISTS next_attempt_at timestamp NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS dashboard_refresh_jobs_claim_v2_idx
ON dashboard_refresh_jobs (status, next_attempt_at, priority, requested_at);

WITH ranked_active_jobs AS (
  SELECT id, row_number() OVER (
    PARTITION BY portal_scope, module_key,
      coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
      range_key, params_hash
    ORDER BY requested_at ASC, created_at ASC
  ) AS duplicate_rank
  FROM dashboard_refresh_jobs
  WHERE status IN ('pending', 'running')
)
UPDATE dashboard_refresh_jobs job
SET status = 'failed', error = 'Superseded duplicate active refresh job',
    finished_at = now(), locked_by = NULL, locked_at = NULL, updated_at = now()
FROM ranked_active_jobs ranked
WHERE job.id = ranked.id AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_refresh_jobs_active_unique
ON dashboard_refresh_jobs (
  portal_scope, module_key,
  coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
  range_key, params_hash
)
WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS automation_cron_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  system varchar(40) NOT NULL,
  schedule_key varchar(80) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'running',
  failure_code varchar(80),
  inserted_runs integer NOT NULL DEFAULT 0,
  total_runs integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_cron_attempts_system_schedule_unique
ON automation_cron_attempts (system, schedule_key);

CREATE INDEX IF NOT EXISTS automation_cron_attempts_created_idx
ON automation_cron_attempts (system, created_at DESC);
