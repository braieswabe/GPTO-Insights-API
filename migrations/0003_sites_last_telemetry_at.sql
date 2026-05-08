-- Heartbeat for dashboard connection status (aligned with telemetry_events.site_id)
ALTER TABLE sites ADD COLUMN IF NOT EXISTS last_telemetry_at timestamp;

UPDATE sites s
SET last_telemetry_at = stats.mx
FROM (
  SELECT site_id, MAX("timestamp") AS mx
  FROM telemetry_events
  GROUP BY site_id
) stats
WHERE s.id = stats.site_id
  AND (s.last_telemetry_at IS NULL OR s.last_telemetry_at < stats.mx);
