import { deriveDataConnection, getConnectionThresholds } from './derive-data-connection.js';

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function asDate(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Map a DB site row (with last_telemetry_at from COALESCE column or subquery) to dashboard sitesList entry.
 * Exported for unit tests.
 * @param {object} row
 * @param {Set<string>} activeConfigSiteIds
 * @param {Date} [now]
 * @param {ReturnType<typeof getConnectionThresholds>} [thresholds]
 */
export function mapSiteRowToSitesListEntry(row, activeConfigSiteIds, now = new Date(), thresholds = getConnectionThresholds()) {
  const lastAt = asDate(row.last_telemetry_at);
  const id = String(row.id);
  const hasActiveConfig = activeConfigSiteIds.has(id);
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastTelemetryAt: lastAt ? lastAt.toISOString() : null,
    hasActiveConfig,
    dataConnection: deriveDataConnection(lastAt, hasActiveConfig, now, thresholds),
  };
}

/**
 * Load sites with lastTelemetryAt = COALESCE(sites.last_telemetry_at, max(telemetry_events.timestamp)).
 * @param {import('postgres').Sql} sql
 * @param {string | null | undefined} siteId
 */
export async function loadSitesWithConnectionFields(sql, siteId) {
  const rows = siteId
    ? await sql`
      SELECT
        s.id,
        s.domain,
        s.status,
        s.created_at,
        s.updated_at,
        COALESCE(
          s.last_telemetry_at,
          (SELECT MAX(e.timestamp) FROM telemetry_events e WHERE e.site_id = s.id)
        ) AS last_telemetry_at
      FROM sites s
      WHERE s.id = ${siteId}::uuid
    `
    : await sql`
      SELECT
        s.id,
        s.domain,
        s.status,
        s.created_at,
        s.updated_at,
        COALESCE(
          s.last_telemetry_at,
          (SELECT MAX(e.timestamp) FROM telemetry_events e WHERE e.site_id = s.id)
        ) AS last_telemetry_at
      FROM sites s
      ORDER BY s.domain ASC
    `;

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const activeRows = await sql`
    SELECT DISTINCT site_id
    FROM config_versions
    WHERE is_active = true
      AND site_id = ANY(${ids}::uuid[])
  `;
  const activeSet = new Set(activeRows.map((r) => String(r.site_id)));

  const now = new Date();
  const thresholds = getConnectionThresholds();
  return rows.map((row) => mapSiteRowToSitesListEntry(row, activeSet, now, thresholds));
}
