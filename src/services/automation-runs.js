import { db } from '../db.js';
import { getUserContext } from '../access.js';
import { parsePositiveInt } from '../contracts.js';

let dbReader = db;

export function setAutomationRunsDbReaderForTests(reader) {
  dbReader = reader || db;
}

function outcomeForStatus(status) {
  const value = String(status || '').toLowerCase();
  if (['completed', 'succeeded', 'success'].includes(value)) return 'succeeded';
  if (['failed', 'partially_failed', 'error', 'cancelled'].includes(value)) return 'failed';
  return 'running';
}

function iso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function readAutomationRuns(request) {
  const user = getUserContext(request);
  if (user.role !== 'admin') {
    const error = new Error('Admin access required');
    error.statusCode = 403;
    throw error;
  }

  const days = parsePositiveInt(request.url.searchParams.get('days'), 14, { min: 1, max: 90 });
  const limit = parsePositiveInt(request.url.searchParams.get('limit'), 100, { min: 1, max: 200 });
  const sql = dbReader();
  const [refreshRows, dataForSeoRows, scannerRows] = await Promise.all([
    sql`
      SELECT id, schedule_key, mode, status, stage, processed_sites, total_sites,
             error, created_at, started_at, finished_at, updated_at
      FROM dashboard_data_refresh_runs
      WHERE created_at >= now() - (${days}::int * interval '1 day')
      ORDER BY created_at DESC
      LIMIT ${limit}
    `,
    sql`
      SELECT b.id, b.trigger, b.schedule_key, b.source, b.status, b.total_jobs,
             b.succeeded_jobs, b.failed_jobs, b.created_at, b.started_at,
             b.finished_at, b.updated_at,
             array_remove(array_agg(DISTINCT j.error), NULL) AS errors
      FROM dataforseo_automation_batches b
      LEFT JOIN dataforseo_automation_jobs j ON j.batch_id = b.id
      WHERE b.created_at >= now() - (${days}::int * interval '1 day')
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT ${limit}
    `,
    sql`
      SELECT r.id, r.site_id, s.domain, r.status, r.scanner_version, r.platforms,
             r.prompt_count, r.total_tasks, r.completed_tasks, r.failed_tasks,
             r.trigger, r.schedule_key, r.error, r.created_at, r.started_at,
             r.finished_at, r.updated_at
      FROM ai_mentions_scan_runs r
      JOIN sites s ON s.id = r.site_id
      WHERE r.created_at >= now() - (${days}::int * interval '1 day')
      ORDER BY r.created_at DESC
      LIMIT ${limit}
    `,
  ]);

  const refresh = refreshRows.map((row) => ({
    id: row.id,
    type: 'dashboard_refresh',
    label: row.mode === 'nightly' ? 'Dashboard nightly reconciliation' : 'Dashboard refresh',
    status: row.status,
    outcome: outcomeForStatus(row.status),
    scheduleKey: row.schedule_key,
    trigger: row.mode,
    stage: row.stage,
    siteId: null,
    siteDomain: null,
    totals: {
      total: Number(row.total_sites || 0),
      succeeded: Number(row.processed_sites || 0),
      failed: row.status === 'failed' ? Math.max(1, Number(row.total_sites || 0) - Number(row.processed_sites || 0)) : 0,
    },
    error: row.error || null,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    updatedAt: iso(row.updated_at),
  }));

  const dataForSeo = dataForSeoRows.map((row) => ({
    id: row.id,
    type: 'dataforseo',
    label: `DataForSEO ${String(row.source || '').replaceAll('_', ' ')}`.trim(),
    status: row.status,
    outcome: outcomeForStatus(row.status),
    scheduleKey: row.schedule_key,
    trigger: row.trigger,
    stage: null,
    siteId: null,
    siteDomain: null,
    totals: {
      total: Number(row.total_jobs || 0),
      succeeded: Number(row.succeeded_jobs || 0),
      failed: Number(row.failed_jobs || 0),
    },
    error: Array.isArray(row.errors) && row.errors.length ? row.errors.slice(0, 3).join(' | ') : null,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    updatedAt: iso(row.updated_at),
  }));

  const scanner = scannerRows.map((row) => ({
    id: row.id,
    type: 'ai_scanner',
    label: `AI Scanner · ${row.domain}`,
    status: row.status,
    outcome: outcomeForStatus(row.status),
    scheduleKey: row.schedule_key,
    trigger: row.trigger,
    stage: row.scanner_version,
    siteId: row.site_id,
    siteDomain: row.domain,
    platforms: Array.isArray(row.platforms) ? row.platforms : [],
    totals: {
      total: Number(row.total_tasks || row.prompt_count || 0),
      succeeded: Number(row.completed_tasks || 0),
      failed: Number(row.failed_tasks || 0),
    },
    error: row.error || null,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    updatedAt: iso(row.updated_at),
  }));

  const runs = [...refresh, ...dataForSeo, ...scanner]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, limit * 3);

  return {
    status: 200,
    body: {
      data: {
        windowDays: days,
        generatedAt: new Date().toISOString(),
        runs,
      },
    },
  };
}
