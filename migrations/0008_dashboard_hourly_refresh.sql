CREATE TABLE IF NOT EXISTS "automation_workload_leases" (
  "name" varchar(80) PRIMARY KEY,
  "owner" varchar(160) NOT NULL,
  "workload_type" varchar(60) NOT NULL,
  "acquired_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp NOT NULL,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "automation_workload_leases_expiry_idx"
ON "automation_workload_leases" ("expires_at");

CREATE TABLE IF NOT EXISTS "dashboard_data_refresh_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "schedule_key" varchar(24) NOT NULL,
  "mode" varchar(20) NOT NULL DEFAULT 'hourly',
  "status" varchar(24) NOT NULL DEFAULT 'queued',
  "stage" varchar(60) NOT NULL DEFAULT 'queued',
  "cursor" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "processed_sites" integer NOT NULL DEFAULT 0,
  "total_sites" integer NOT NULL DEFAULT 0,
  "started_at" timestamp,
  "finished_at" timestamp,
  "error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "dashboard_data_refresh_runs_schedule_unique"
ON "dashboard_data_refresh_runs" ("schedule_key", "mode");

CREATE INDEX IF NOT EXISTS "dashboard_data_refresh_runs_status_idx"
ON "dashboard_data_refresh_runs" ("status", "created_at");

CREATE INDEX IF NOT EXISTS "dashboard_data_refresh_runs_finished_idx"
ON "dashboard_data_refresh_runs" ("finished_at" DESC)
WHERE "status" = 'completed';
