-- Daily telemetry rollup progress + dedupe + unique guard for (site_id, UTC calendar day)
-- Idempotent: safe to run repeatedly.

-- Remove duplicate dashboard_rollups_daily rows per site + UTC calendar day (keep newest by created_at)
DELETE FROM dashboard_rollups_daily a
WHERE a.ctid IN (
  SELECT ctid FROM (
    SELECT ctid,
           ROW_NUMBER() OVER (
             PARTITION BY site_id, ((day::timestamp AT TIME ZONE 'UTC')::date)
             ORDER BY created_at DESC NULLS LAST, id::text DESC
           ) AS rn
    FROM dashboard_rollups_daily
  ) sub
  WHERE sub.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS dashboard_rollups_daily_site_utc_day_uniq
ON dashboard_rollups_daily (site_id, ((day::timestamp AT TIME ZONE 'UTC')::date));

CREATE TABLE IF NOT EXISTS dashboard_telemetry_daily_rollup_progress (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending',
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  events_scanned integer NULL,
  max_event_timestamp timestamptz NULL,
  error text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, day)
);

CREATE INDEX IF NOT EXISTS dashboard_telemetry_daily_rollup_progress_day_idx
ON dashboard_telemetry_daily_rollup_progress (day);

CREATE INDEX IF NOT EXISTS dashboard_telemetry_daily_rollup_progress_status_idx
ON dashboard_telemetry_daily_rollup_progress (status, day);
