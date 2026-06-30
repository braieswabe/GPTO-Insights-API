import { db } from '../db.js';
import { ok } from '../contracts.js';
import { assertUtcRangeWithin, utcDayExclusiveEnd, utcDayStart } from '../telemetry-rollup-dates.js';
import {
  aggregateValidTelemetryTopPages,
  isTelemetryPageEligibleForPageViewTotals,
  isTelemetryPageEligibleForTopPages,
  isWordPressAdminOrEditorTelemetryUrl,
} from '../lib/telemetry-pages.js';

const DEFAULT_MAX_SPAN_DAYS = 366;
const DEFAULT_MAX_SITES = 80;
const DEFAULT_MAX_RUNS = 500;

function safeRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function eventPage(row) {
  const page = safeRecord(row.page);
  const context = safeRecord(row.context);
  const metrics = safeRecord(row.metrics);
  const url =
    stringValue(page.url) ||
    stringValue(page.href) ||
    stringValue(context.url) ||
    stringValue(metrics.url) ||
    'unknown';
  return {
    url,
    path: stringValue(page.path) || stringValue(context.path),
    title: stringValue(page.title) || stringValue(context.title),
    isNotFound: page.isNotFound,
  };
}

function eventIntent(row) {
  const context = safeRecord(row.context);
  const metrics = safeRecord(row.metrics);
  return stringValue(context.intent) || stringValue(metrics.intent) || stringValue(metrics.detectedIntent);
}

function incrementMap(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}


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

  // Past UTC days are immutable once complete; today's UTC day must always re-run
  // because new events keep arriving for the same day.
  const todayIso = new Date().toISOString().slice(0, 10);
  const isTodayUtc = dayIso === todayIso;
  if (!force && !isTodayUtc) {
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

  const eventRows = await tx`
    SELECT event_type, session_id, timestamp, page, context, metrics, search
    FROM telemetry_events
    WHERE site_id = ${siteId}::uuid
      AND "timestamp" >= ${dayStart}
      AND "timestamp" < ${dayEnd}
  `;

  const eventsScanned = eventRows.length;
  let maxEventTimestamp = null;
  let pageViews = 0;
  let searches = 0;
  let interactions = 0;
  const visitsSet = new Set();
  const topPageCandidates = [];
  const intents = new Map();

  for (const row of eventRows) {
    if (!maxEventTimestamp || new Date(row.timestamp) > new Date(maxEventTimestamp)) {
      maxEventTimestamp = row.timestamp;
    }

    const page = eventPage(row);
    if (isWordPressAdminOrEditorTelemetryUrl(page.url)) continue;

    const eventType = String(row.event_type || '').toLowerCase();
    let countsForVisit = false;
    if (eventType === 'page_view' || eventType === 'pageview') {
      if (!isTelemetryPageEligibleForPageViewTotals(page)) continue;
      pageViews += 1;
      countsForVisit = true;
      if (isTelemetryPageEligibleForTopPages(page, row.context)) {
        topPageCandidates.push({ ...page, count: 1, views: 1 });
      }
    } else if (eventType === 'search') {
      searches += 1;
      countsForVisit = true;
    } else {
      interactions += 1;
      countsForVisit = true;
    }

    if (countsForVisit && row.session_id) visitsSet.add(String(row.session_id));
    const intent = eventIntent(row);
    if (countsForVisit && intent) incrementMap(intents, intent);
  }

  const visits = visitsSet.size || pageViews || interactions || searches;
  const topPages = aggregateValidTelemetryTopPages(topPageCandidates, { limit: 25 });
  const topIntents = Array.from(intents.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([intent, count]) => ({ intent, count }));

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
      ${searches},
      ${interactions},
      ${tx.json(topPages)},
      ${tx.json(topIntents)},
      NULL
    )
  `;

  await tx`
    UPDATE dashboard_telemetry_daily_rollup_progress
    SET status = 'complete',
        finished_at = now(),
        events_scanned = ${eventsScanned},
        max_event_timestamp = ${maxEventTimestamp ?? null},
        error = NULL,
        updated_at = now()
    WHERE site_id = ${siteId}::uuid AND day = ${dayIso}::date
  `;

  if (maxEventTimestamp) {
    await tx`
      UPDATE sites
      SET
        last_telemetry_at = GREATEST(
          COALESCE(last_telemetry_at, to_timestamp(0)),
          ${maxEventTimestamp}
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
    maxEventTimestamp: maxEventTimestamp ? new Date(maxEventTimestamp).toISOString() : null,
    visits,
    pageViews,
    searches,
    interactions,
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
