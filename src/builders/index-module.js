import { db } from '../db.js';
import { boundsFromInput } from '../dashboard-range.js';
import { deriveDataConnection, getConnectionThresholds } from '../derive-data-connection.js';

const MODULE_KEYS = [
  'telemetry',
  'authority',
  'confusion',
  'coverage',
  'schema',
  'journey',
  'experience',
  'search_diagnostics',
  'executive_summary',
  'ai_readability',
  'llm_ai_visibility',
];

function levelFromCount(count) {
  if (count > 20) return 'High';
  if (count > 5) return 'Medium';
  if (count > 0) return 'Low';
  return 'Unknown';
}

async function loadModuleConfidenceCounts(sql, siteIds, start, end) {
  if (!siteIds.length) {
    return MODULE_KEYS.reduce((acc, key) => {
      acc[key] = 0;
      return acc;
    }, {});
  }

  const counts = {};
  const queries = await Promise.all([
    sql`SELECT COUNT(*)::int AS c FROM dashboard_rollups_daily WHERE site_id = ANY(${siteIds}::uuid[]) AND day >= ${start} AND day <= ${end}`,
    sql`SELECT COUNT(*)::int AS c FROM authority_signals WHERE site_id = ANY(${siteIds}::uuid[]) AND window_end >= ${start} AND window_start <= ${end}`,
    sql`SELECT COUNT(*)::int AS c FROM confusion_signals WHERE site_id = ANY(${siteIds}::uuid[]) AND window_end >= ${start} AND window_start <= ${end}`,
    sql`SELECT COUNT(*)::int AS c FROM coverage_signals WHERE site_id = ANY(${siteIds}::uuid[]) AND window_end >= ${start} AND window_start <= ${end}`,
    sql`SELECT COUNT(*)::int AS c FROM telemetry_events WHERE site_id = ANY(${siteIds}::uuid[]) AND timestamp >= ${start} AND timestamp <= ${end}`,
    sql`SELECT COUNT(*)::int AS c FROM journey_signals WHERE site_id = ANY(${siteIds}::uuid[]) AND window_end >= ${start} AND window_start <= ${end}`,
    sql`SELECT COUNT(*)::int AS c FROM experience_signals WHERE site_id = ANY(${siteIds}::uuid[]) AND window_end >= ${start} AND window_start <= ${end}`,
    sql`SELECT COUNT(*)::int AS c FROM search_signals WHERE site_id = ANY(${siteIds}::uuid[]) AND window_end >= ${start} AND window_start <= ${end}`,
    sql`SELECT COUNT(*)::int AS c FROM readability_signals WHERE site_id = ANY(${siteIds}::uuid[]) AND window_end >= ${start} AND window_start <= ${end}`,
    sql`SELECT COUNT(*)::int AS c FROM llm_mentions_snapshots WHERE site_id = ANY(${siteIds}::uuid[]) AND status = 'success' AND fetched_at >= ${start} AND fetched_at <= ${end}`,
  ]);

  counts.telemetry = queries[0][0]?.c ?? 0;
  counts.authority = queries[1][0]?.c ?? 0;
  counts.confusion = queries[2][0]?.c ?? 0;
  counts.coverage = queries[3][0]?.c ?? 0;
  counts.schema = queries[4][0]?.c ?? 0;
  counts.journey = queries[5][0]?.c ?? 0;
  counts.experience = queries[6][0]?.c ?? 0;
  counts.search_diagnostics = queries[7][0]?.c ?? 0;
  counts.executive_summary = counts.telemetry + counts.authority;
  counts.ai_readability = queries[8][0]?.c ?? 0;
  counts.llm_ai_visibility = queries[9][0]?.c ?? 0;
  return counts;
}

async function loadConnectionRows(sql, siteIds) {
  if (!siteIds.length) return new Map();
  const rows = await sql`
    SELECT
      s.id,
      COALESCE(s.last_telemetry_at, (SELECT MAX(e.timestamp) FROM telemetry_events e WHERE e.site_id = s.id)) AS last_telemetry_at,
      EXISTS (SELECT 1 FROM config_versions cv WHERE cv.site_id = s.id AND cv.is_active = true) AS has_active_config
    FROM sites s
    WHERE s.id = ANY(${siteIds}::uuid[])
  `;
  return new Map(rows.map((row) => [String(row.id), row]));
}

export async function buildIndex(input) {
  const { siteId, rangeKey } = input;
  const sql = db();
  const { start, end } = boundsFromInput(input);

  const sites = siteId
    ? await sql`SELECT id, domain, status, created_at, updated_at FROM sites WHERE id = ${siteId}::uuid`
    : await sql`SELECT id, domain, status, created_at, updated_at FROM sites ORDER BY domain ASC`;

  if (sites.length === 0) {
    return { range: rangeKey, dashboards: [], llmAiVisibility: null };
  }

  const ids = sites.map((s) => s.id);
  const [moduleCounts, connectionRows] = await Promise.all([
    loadModuleConfidenceCounts(sql, ids, start, end),
    loadConnectionRows(sql, ids),
  ]);
  const thresholds = getConnectionThresholds();
  const now = new Date();

  const dashboards = sites.map((s) => {
    const conn = connectionRows.get(String(s.id));
    const lastAt = conn?.last_telemetry_at ? new Date(conn.last_telemetry_at) : null;
    const dataConnection = deriveDataConnection(lastAt, Boolean(conn?.has_active_config), now, thresholds);
    const isConnected = dataConnection === 'connected';

    const overallCount = (moduleCounts.telemetry || 0) + (moduleCounts.authority || 0) + (moduleCounts.coverage || 0);
    const overallConfidence = isConnected ? levelFromCount(overallCount) : overallCount > 0 ? 'Low' : 'Unknown';

    return {
      id: s.id,
      name: s.domain,
      detailType: 'overview',
      status: s.status === 'active' ? 'Active' : s.status === 'pending' ? 'Waiting' : 'Active',
      dataConnected: isConnected,
      dataConnection,
      lastTelemetryAt: lastAt ? lastAt.toISOString() : null,
      lastUpdate: s.updated_at ? new Date(s.updated_at).toISOString() : null,
      confidence: overallConfidence,
      modules: MODULE_KEYS.reduce((acc, key) => {
        const count = moduleCounts[key] ?? 0;
        acc[key] = {
          dataConnected: count > 0,
          confidence: count > 0 ? levelFromCount(count) : 'Unknown',
          rowCount: count,
        };
        return acc;
      }, {}),
    };
  });

  const llmAiVisibility = moduleCounts.llm_ai_visibility > 0
    ? { dataConnected: true, confidence: levelFromCount(moduleCounts.llm_ai_visibility) }
    : null;

  return {
    range: rangeKey,
    dashboards,
    llmAiVisibility,
  };
}
