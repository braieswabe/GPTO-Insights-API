CREATE TABLE IF NOT EXISTS dataforseo_automation_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger varchar(20) NOT NULL,
  schedule_key varchar(80),
  source varchar(40) NOT NULL DEFAULT 'chat_gpt',
  status varchar(30) NOT NULL DEFAULT 'queued',
  requested_by uuid NULL REFERENCES users(id),
  total_jobs integer NOT NULL DEFAULT 0,
  succeeded_jobs integer NOT NULL DEFAULT 0,
  failed_jobs integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  started_at timestamp NULL,
  finished_at timestamp NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dataforseo_automation_batches_schedule_uidx
ON dataforseo_automation_batches (schedule_key, source)
WHERE schedule_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS dataforseo_automation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES dataforseo_automation_batches(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  endpoint varchar(80) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  locked_by varchar(160),
  locked_at timestamp NULL,
  snapshot_id uuid NULL REFERENCES llm_mentions_snapshots(id),
  process_summary jsonb NULL,
  cost numeric(12, 6) DEFAULT 0,
  error text NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  started_at timestamp NULL,
  finished_at timestamp NULL,
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (batch_id, site_id, endpoint)
);

CREATE INDEX IF NOT EXISTS dataforseo_automation_jobs_claim_idx
ON dataforseo_automation_jobs (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS dataforseo_automation_jobs_batch_idx
ON dataforseo_automation_jobs (batch_id, status);
