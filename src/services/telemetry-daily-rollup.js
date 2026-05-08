import { db } from '../db.js';
import { ok } from '../contracts.js';
import { assertUtcRangeWithin, utcDayExclusiveEnd, utcDayStart } from '../telemetry-rollup-dates.js';

const DEFAULT_MAX_SPAN_DAYS = 366;
const DEFAULT_MAX_SITES = 80;
const DEFAULT_MAX_RUNS = 500;

/**
 * @param {import('postgres').Sql} sql
 * @param {number} maxSites
 * @param {string | null} singleSiteId
 */
async function listRollupSiteIds(sql, maxSites, singleSiteId) {
  if (singleSiteId) {
    const [row] = await sql`
      SELECT id FROM sites WHERE id = ${singleSiteId}::uuid LIMIT 1
    `;
    return row ? [String(row.id)] : [];
  }
  const rows = await sql`
    SELECT id FROM sites
    WHERE status = 'active'
    ORDER BY domain ASC
    LIMIT ${maxSites}
  `;
  return rows.map((r) => String(r.id));
}

/**
 * One site × one UTC calendar day. Uses a transaction.
 * @param {import('postgres').TransactionSql} tx
 * @param {string} siteId
 * @param {string} dayIso YYYY-MM-DD UTC
 * @param {{ force?: boolean }} opts
 */
export async function rollupSiteDayTx(tx, siteId, dayIso, { force = false } = {}) {
  const dayStart = utcDayStart(dayIso);
  const dayEnd = utcDayExclusiveEnd(dayIso);

  if (!force) {
    const [existing] = await tx`
      SELECT status FROM dashboard_telemetry_daily_rollup_progress
      WHERE site_id = ${siteId}::uuid AND day = ${dayIso}::date
      LIMIT 1
    `;
    if (existing?.status === 'complete') {
      return { skipped: true, reason: 'already_complete', siteId, day: dayIso };
    }
  }

  await tx`
    INSERT INTO dashboard_telemetry_daily_rollup_progress (site_id, day, status, started_at, updated_at)
    VALUES (${siteId}::uuid, ${dayIso}::date, 'running', now(), now())
    ON CONFLICT (site_id, day) DO UPDATE SET
      status = 'running',
      started_at = now(),
      finished_at = NULL,
      error = NULL,
      events_scanned = NULL,
      max_event_timestamp = NULL,
      updated_at = now()
  `;

  const [agg] = await tx`
    SELECT
      COUNT(*)::int AS events_scanned,
      MAX("timestamp") AS max_event_timestamp,
      COUNT(*) FILTER (WHERE event_type = 'page_view')::int AS page_views,
      COUNT(*) FILTER (WHERE event_type = 'search')::int AS searches,
      COUNT(*) FILTER (WHERE event_type = 'interaction')::int AS interactions,
      COUNT(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL)::int AS visits_sessions
    FROM telemetry_events
    WHERE site_id = ${siteId}::uuid
      AND "timestamp" >= ${dayStart}
      AND "timestamp" < ${dayEnd}
  `;

  const eventsScanned = Number(agg?.events_scanned || 0);
  const pageViews = Number(agg?.page_views || 0);
  const visitsSessions = Number(agg?.visits_sessions || 0);
  const visits = visitsSessions > 0 ? visitsSessions : pageViews;

  await tx`
    DELETE FROM dashboard_rollups_daily
    WHERE site_id = ${siteId}::uuid
      AND (timezone('UTC', day))::date = ${dayIso}::date
  `;

  await tx`
    INSERT INTO dashboard_rollups_daily (
      site_id, day, visits, page_views, searches, interactions,
      top_pages, top_intents, metrics
    ) VALUES (
      ${siteId}::uuid,
      ${dayStart},
      ${visits},
      ${pageViews},
      ${Number(agg?.searches || 0)},
      ${Number(agg?.interactions || 0)},
      NULL,
      NULL,
      NULL
    )
  `;

  await tx`
    UPDATE dashboard_telemetry_daily_rollup_progress
    SET status = 'complete',
        finished_at = now(),
        events_scanned = ${eventsScanned},
        max_event_timestamp = ${agg?.max_event_timestamp ?? null},
        error = NULL,
        updated_at = now()
    WHERE site_id = ${siteId}::uuid AND day = ${dayIso}::date
  `;

  if (agg?.max_event_timestamp) {
    await tx`
      UPDATE sites
      SET
        last_telemetry_at = GREATEST(
          COALESCE(last_telemetry_at, to_timestamp(0)),
          ${agg.max_event_timestamp}
        ),
        updated_at = NOW()
      WHERE id = ${siteId}::uuid
    `;
  }

  return {
    skipped: false,
    siteId,
    day: dayIso,
    eventsScanned,
    maxEventTimestamp: agg?.max_event_timestamp ? new Date(agg.max_event_timestamp).toISOString() : null,
    visits,
    pageViews,
    searches: Number(agg?.searches || 0),
    interactions: Number(agg?.interactions || 0),
  };
}

/**
 * @param {string} siteId
 * @param {string} dayIso
 * @param {{ force?: boolean }} opts
 */
export async function rollupSiteDayCommitted(siteId, dayIso, opts = {}) {
  const sql = db();
  try {
    return await sql.begin(async (tx) => rollupSiteDayTx(tx, siteId, dayIso, opts));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    try {
      await sql`
        INSERT INTO dashboard_telemetry_daily_rollup_progress (
          site_id, day, status, started_at, finished_at, error, updated_at
        ) VALUES (
          ${siteId}::uuid,
          ${dayIso}::date,
          'failed',
          now(),
          now(),
          ${msg},
          now()
        )
        ON CONFLICT (site_id, day) DO UPDATE SET
          status = 'failed',
          finished_at = now(),
          error = ${msg},
          updated_at = now()
      `;
    } catch {
      // ignore secondary failure
    }
    throw error;
  }
}

/**
 * @param {{
 *   siteId?: string | null,
 *   from: string,
 *   to: string,
 *   force?: boolean,
 *   maxSites?: number,
 *   maxRuns?: number,
 * }} input
 */
export async function rollupTelemetryDaily(input) {
  const maxSpan = Number(process.env.TELEMETRY_ROLLUP_MAX_SPAN_DAYS || DEFAULT_MAX_SPAN_DAYS);
  const maxSites = Math.max(
    1,
    Math.min(Number(input.maxSites ?? (process.env.TELEMETRY_ROLLUP_MAX_SITES || DEFAULT_MAX_SITES)), 500)
  );
  const maxRuns = Math.max(
    1,
    Math.min(Number(input.maxRuns ?? (process.env.TELEMETRY_ROLLUP_MAX_RUNS || DEFAULT_MAX_RUNS)), 5000)
  );

  const days = assertUtcRangeWithin(input.from, input.to, maxSpan);
  const sql = db();
  const siteIds = await listRollupSiteIds(sql, maxSites, input.siteId || null);

  const results = [];
  let runs = 0;
  let truncated = false;

  for (const siteId of siteIds) {
    for (const dayIso of days) {
      if (runs >= maxRuns) {
        truncated = true;
        break;
      }
      try {
        const row = await rollupSiteDayCommitted(siteId, dayIso, { force: input.force === true });
        results.push(row);
      } catch (error) {
        results.push({
          skipped: false,
          siteId,
          day: dayIso,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      runs += 1;
    }
    if (truncated) break;
  }

  return {
    ok: true,
    from: input.from,
    to: input.to,
    siteId: input.siteId || null,
    days: days.length,
    sites: siteIds.length,
    runs,
    truncated,
    results,
  };
}

/**
 * Cron-friendly: last `daysBack` UTC calendar days through today (inclusive).
 * @param {{ daysBack?: number, maxSites?: number, maxRuns?: number }} opts
 */
export async function runTelemetryRollupCronWindow(opts = {}) {
  const daysBack = Math.max(1, Math.min(Number(opts.daysBack ?? (process.env.TELEMETRY_ROLLUP_CRON_DAYS_BACK || 2)), 30));
  const maxSites = Math.max(1, Math.min(Number(opts.maxSites ?? (process.env.TELEMETRY_ROLLUP_CRON_MAX_SITES || 40)), 200));
  const maxRuns = Math.max(1, Math.min(Number(opts.maxRuns ?? (process.env.TELEMETRY_ROLLUP_CRON_MAX_RUNS || 120)), 2000));

  const now = new Date();
  const to = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (daysBack - 1)));
  const from = fromDate.toISOString().slice(0, 10);

  return rollupTelemetryDaily({
    from,
    to,
    force: false,
    maxSites,
    maxRuns,
  });
}

/**
 * @param {Request} request
 * @param {Record<string, unknown>} body
 */
export async function postTelemetryDailyRollup(_request, body) {
  const from = typeof body?.from === 'string' ? body.from : null;
  const to = typeof body?.to === 'string' ? body.to : null;
  if (!from || !to) {
    return { status: 400, body: { error: 'from and to are required (UTC YYYY-MM-DD)' } };
  }
  const siteId = typeof body?.siteId === 'string' ? body.siteId : null;
  const force = body?.force === true;
  const maxSites = body?.maxSites != null ? Number(body.maxSites) : undefined;
  const maxRuns = body?.maxRuns != null ? Number(body.maxRuns) : undefined;

  try {
    const payload = await rollupTelemetryDaily({ from, to, siteId, force, maxSites, maxRuns });
    return ok(payload);
  } catch (error) {
    const status = error.statusCode && Number.isFinite(error.statusCode) ? error.statusCode : 400;
    return { status, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * @param {Request} request
 */
export async function getTelemetryDailyRollupProgress(request) {
  const url = request.url;
  const siteId = url.searchParams.get('siteId');
  const from = url.searchParams.get('from');
  const end = url.searchParams.get('end') || url.searchParams.get('to');
  if (!siteId) {
    return { status: 400, body: { error: 'siteId is required' } };
  }
  if (!from || !end) {
    return { status: 400, body: { error: 'from and end (or to) are required (UTC YYYY-MM-DD)' } };
  }
  try {
    const maxSpan = Number(process.env.TELEMETRY_ROLLUP_MAX_SPAN_DAYS || DEFAULT_MAX_SPAN_DAYS);
    assertUtcRangeWithin(from, end, maxSpan);
  } catch (error) {
    const status = error.statusCode && Number.isFinite(error.statusCode) ? error.statusCode : 400;
    return { status, body: { error: error instanceof Error ? error.message : String(error) } };
  }

  const sql = db();
  const rows = await sql`
    WITH days AS (
      SELECT generate_series(${from}::date, ${end}::date, interval '1 day')::date AS day
    )
    SELECT
      d.day::text AS day,
      p.status,
      p.started_at,
      p.finished_at,
      p.events_scanned,
      p.max_event_timestamp,
      p.error,
      EXISTS (
        SELECT 1 FROM dashboard_rollups_daily r
        WHERE r.site_id = ${siteId}::uuid
          AND (timezone('UTC', r.day))::date = d.day
      ) AS has_rollup_row
    FROM days d
    LEFT JOIN dashboard_telemetry_daily_rollup_progress p
      ON p.site_id = ${siteId}::uuid AND p.day = d.day
    ORDER BY d.day ASC
  `;

  return ok({
    siteId,
    from,
    end,
    days: rows.map((r) => ({
      day: r.day,
      status: r.status || (r.has_rollup_row ? 'rollup_only' : 'missing'),
      startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      eventsScanned: r.events_scanned,
      maxEventTimestamp: r.max_event_timestamp ? new Date(r.max_event_timestamp).toISOString() : null,
      error: r.error,
      hasRollupRow: Boolean(r.has_rollup_row),
    })),
  });
}
