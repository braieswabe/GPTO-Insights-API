ALTER TABLE ai_mentions_scan_runs
  ADD COLUMN IF NOT EXISTS trigger varchar(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS schedule_key varchar(20),
  ADD COLUMN IF NOT EXISTS preparation_attempts integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS ai_mentions_scan_runs_site_schedule_unique
ON ai_mentions_scan_runs (site_id, schedule_key)
WHERE schedule_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_mentions_scan_runs_prepare_idx
ON ai_mentions_scan_runs (status, created_at)
WHERE status IN ('preparing', 'preparing_running', 'finalizing');

CREATE TABLE IF NOT EXISTS ai_mentions_worker_leases (
  name varchar(80) PRIMARY KEY,
  owner varchar(160) NOT NULL,
  expires_at timestamp NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);
