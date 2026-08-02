import os from 'node:os';
import { db } from '../db.js';

export const DATAFORSEO_AUTOMATION_ENDPOINTS = [
  'aggregated_metrics',
  'top_domains',
  'top_pages',
  'search',
];

export const DATAFORSEO_AUTOMATION_SOURCES = ['chat_gpt', 'google_ai_overviews'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function dataForSeoAutomationEnabled() {
  return ['1', 'true', 'yes'].includes(String(process.env.DATAFORSEO_AUTOMATION_ENABLED || '').toLowerCase());
}

export function manilaScheduleKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function requireEnabled() {
  if (!dataForSeoAutomationEnabled()) {
    const error = new Error('DataForSEO automation is disabled');
    error.statusCode = 503;
    throw error;
  }
}

function requireUuid(value, label) {
  if (!UUID_RE.test(String(value || ''))) {
    const error = new Error(`${label} must be a UUID`);
    error.statusCode = 400;
    throw error;
  }
  return String(value);
}

export function normalizeManualDataForSeoSource(value) {
  if (value === undefined || value === null || value === '') return 'chat_gpt';
  if (!DATAFORSEO_AUTOMATION_SOURCES.includes(value)) {
    const error = new Error(`source must be one of: ${DATAFORSEO_AUTOMATION_SOURCES.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  return value;
}

async function updateBatchTotals(sql, batchId) {
  const [counts] = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status IN ('pending', 'pulling', 'processing'))::int AS active,
      count(*) FILTER (WHERE status IN ('pulling', 'processing'))::int AS running
    FROM dataforseo_automation_jobs
    WHERE batch_id = ${batchId}::uuid
  `;
  const total = Number(counts?.total || 0);
  const succeeded = Number(counts?.succeeded || 0);
  const failed = Number(counts?.failed || 0);
  const active = Number(counts?.active || 0);
  const running = Number(counts?.running || 0);
  let status = total === 0 ? 'succeeded' : 'queued';
  if (active > 0) status = running || succeeded || failed ? 'running' : 'queued';
  else if (total > 0 && failed === 0) status = 'succeeded';
  else if (succeeded > 0 && failed > 0) status = 'partially_failed';
  else if (failed > 0) status = 'failed';

  await sql`
    UPDATE dataforseo_automation_batches
    SET status = ${status},
        total_jobs = ${total},
        succeeded_jobs = ${succeeded},
        failed_jobs = ${failed},
        started_at = CASE WHEN ${running + succeeded + failed} > 0 THEN COALESCE(started_at, now()) ELSE started_at END,
        finished_at = CASE WHEN ${active} = 0 THEN now() ELSE NULL END,
        updated_at = now()
    WHERE id = ${batchId}::uuid
  `;
  return { total, succeeded, failed, active, status };
}

export async function enqueueScheduledDataForSeoBatch(options = {}) {
  requireEnabled();
  const sql = db();
  const scheduleKey = options.scheduleKey || manilaScheduleKey(options.now);
  return sql.begin(async (tx) => {
    const batches = [];
    for (const source of DATAFORSEO_AUTOMATION_SOURCES) {
      const inserted = await tx`
        INSERT INTO dataforseo_automation_batches (trigger, schedule_key, source, status)
        VALUES ('scheduled', ${scheduleKey}, ${source}, 'queued')
        ON CONFLICT (schedule_key, source) WHERE schedule_key IS NOT NULL DO NOTHING
        RETURNING id
      `;
      const [existing] = inserted.length
        ? inserted
        : await tx`
            SELECT id FROM dataforseo_automation_batches
            WHERE schedule_key = ${scheduleKey} AND source = ${source}
            LIMIT 1
          `;
      const batchId = existing.id;
      await tx`
        INSERT INTO dataforseo_automation_jobs (batch_id, site_id, endpoint)
        SELECT ${batchId}::uuid, s.id, endpoint
        FROM sites s
        CROSS JOIN unnest(${DATAFORSEO_AUTOMATION_ENDPOINTS}::text[]) AS endpoint
        WHERE s.status = 'active'
        ON CONFLICT (batch_id, site_id, endpoint) DO NOTHING
      `;
      const counts = await updateBatchTotals(tx, batchId);
      batches.push({ batchId, source, duplicate: inserted.length === 0, ...counts });
    }
    return {
      ok: true,
      scheduleKey,
      batches,
      batchId: batches[0]?.batchId || null,
      total: batches.reduce((sum, batch) => sum + batch.total, 0),
      succeeded: batches.reduce((sum, batch) => sum + batch.succeeded, 0),
      failed: batches.reduce((sum, batch) => sum + batch.failed, 0),
      active: batches.reduce((sum, batch) => sum + batch.active, 0),
      duplicate: batches.every((batch) => batch.duplicate),
    };
  });
}

export async function enqueueManualDataForSeoBatch(body = {}) {
  requireEnabled();
  const siteId = requireUuid(body.siteId, 'siteId');
  const source = normalizeManualDataForSeoSource(body.source);
  const requestedBy = UUID_RE.test(String(body.requestedBy || '')) ? String(body.requestedBy) : null;
  const sql = db();
  return sql.begin(async (tx) => {
    const [site] = await tx`SELECT id, domain FROM sites WHERE id = ${siteId}::uuid LIMIT 1`;
    if (!site) {
      const error = new Error('Site not found');
      error.statusCode = 404;
      throw error;
    }
    const [batch] = await tx`
      INSERT INTO dataforseo_automation_batches (trigger, source, status, requested_by)
      VALUES ('manual', ${source}, 'queued', ${requestedBy}::uuid)
      RETURNING id
    `;
    await tx`
      INSERT INTO dataforseo_automation_jobs (batch_id, site_id, endpoint)
      SELECT ${batch.id}::uuid, ${siteId}::uuid, endpoint
      FROM unnest(${DATAFORSEO_AUTOMATION_ENDPOINTS}::text[]) AS endpoint
    `;
    const counts = await updateBatchTotals(tx, batch.id);
    return { ok: true, batchId: batch.id, siteId, domain: site.domain, source, ...counts };
  });
}

export async function readDataForSeoBatch(batchId) {
  requireUuid(batchId, 'batchId');
  const sql = db();
  const [batch] = await sql`
    SELECT * FROM dataforseo_automation_batches WHERE id = ${batchId}::uuid LIMIT 1
  `;
  if (!batch) {
    const error = new Error('Automation batch not found');
    error.statusCode = 404;
    throw error;
  }
  const jobs = await sql`
    SELECT j.id, j.site_id, s.domain, s.display_name, j.endpoint, j.status, j.attempts,
           j.next_attempt_at, j.snapshot_id, j.process_summary, j.cost, j.error,
           j.started_at, j.finished_at
    FROM dataforseo_automation_jobs j
    JOIN sites s ON s.id = j.site_id
    WHERE j.batch_id = ${batchId}::uuid
    ORDER BY s.domain ASC, array_position(${DATAFORSEO_AUTOMATION_ENDPOINTS}::text[], j.endpoint)
  `;
  return {
    id: batch.id,
    trigger: batch.trigger,
    scheduleKey: batch.schedule_key,
    source: batch.source,
    status: batch.status,
    counts: {
      total: batch.total_jobs,
      succeeded: batch.succeeded_jobs,
      failed: batch.failed_jobs,
      active: Math.max(0, batch.total_jobs - batch.succeeded_jobs - batch.failed_jobs),
    },
    createdAt: batch.created_at,
    startedAt: batch.started_at,
    finishedAt: batch.finished_at,
    jobs: jobs.map((job) => ({
      id: job.id,
      siteId: job.site_id,
      domain: job.domain,
      displayName: job.display_name,
      endpoint: job.endpoint,
      status: job.status,
      attempts: job.attempts,
      nextAttemptAt: job.next_attempt_at,
      snapshotId: job.snapshot_id,
      processSummary: job.process_summary,
      cost: Number(job.cost || 0),
      error: job.error,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
    })),
  };
}

export async function retryFailedDataForSeoBatch(batchId) {
  requireEnabled();
  requireUuid(batchId, 'batchId');
  const sql = db();
  const rows = await sql`
    UPDATE dataforseo_automation_jobs
    SET status = 'pending', attempts = 0, next_attempt_at = now(),
        locked_by = NULL, locked_at = NULL, error = NULL, finished_at = NULL, updated_at = now()
    WHERE batch_id = ${batchId}::uuid AND status = 'failed'
    RETURNING id
  `;
  await updateBatchTotals(sql, batchId);
  return { ok: true, batchId, retried: rows.length };
}

async function claimJobs(limit) {
  const sql = db();
  const lockMinutes = Math.max(2, Number(process.env.DATAFORSEO_AUTOMATION_LOCK_MINUTES || 5));
  const workerId = `${os.hostname()}:${process.pid}`;
  await sql`
    UPDATE dataforseo_automation_jobs
    SET status = 'pending', locked_by = NULL, locked_at = NULL, next_attempt_at = now(),
        error = 'Recovered stale worker lock', updated_at = now()
    WHERE status IN ('pulling', 'processing') AND locked_at < now() - (${lockMinutes} * interval '1 minute')
  `;
  const jobs = await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT j.*, b.trigger, b.source, b.schedule_key
      FROM dataforseo_automation_jobs j
      JOIN dataforseo_automation_batches b ON b.id = j.batch_id
      WHERE j.status = 'pending' AND j.next_attempt_at <= now()
      ORDER BY j.created_at ASC
      LIMIT ${limit}
      FOR UPDATE OF j SKIP LOCKED
    `;
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    await tx`
      UPDATE dataforseo_automation_jobs
      SET status = 'pulling', attempts = attempts + 1, locked_by = ${workerId},
          locked_at = now(), started_at = COALESCE(started_at, now()), error = NULL, updated_at = now()
      WHERE id = ANY(${ids}::uuid[])
    `;
    return rows.map((row) => ({ ...row, attempts: Number(row.attempts || 0) + 1 }));
  });
  for (const batchId of new Set(jobs.map((job) => job.batch_id))) {
    await updateBatchTotals(sql, batchId);
  }
  return jobs;
}

async function invalidateCompletedSiteCache(sql, job) {
  const [remaining] = await sql`
    SELECT count(*)::int AS count
    FROM dataforseo_automation_jobs
    WHERE batch_id = ${job.batch_id}::uuid
      AND site_id = ${job.site_id}::uuid
      AND status <> 'succeeded'
  `;
  if (Number(remaining?.count || 0) === 0) {
    await sql`
      DELETE FROM dashboard_api_cache
      WHERE site_id = ${job.site_id}::uuid
        AND module_key = ANY(${[
          'llm_mentions_overview', 'overview', 'gold', 'stats', 'csuite',
          'monthly_insights', 'export_data',
        ]}::text[])
    `;
  }
}

async function executeJob(job) {
  const base = process.env.GPTO_DASHBOARD_BASE_URL?.replace(/\/+$/, '');
  const token = process.env.GPTO_DATAFORSEO_AUTOMATION_TOKEN;
  if (!base || !token) {
    return { ok: false, retryable: false, error: 'GPTO dashboard automation endpoint is not configured' };
  }
  const timeoutMs = Math.max(5_000, Number(process.env.DATAFORSEO_AUTOMATION_REQUEST_TIMEOUT_MS || 170_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/internal/dataforseo/execute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id,
        batchId: job.batch_id,
        siteId: job.site_id,
        endpoint: job.endpoint,
        trigger: job.trigger,
        source: job.source,
        scheduleKey: job.schedule_key,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        retryable: body.retryable === true || response.status === 429 || response.status >= 500,
        error: body.message || body.error || `GPTO executor HTTP ${response.status}`,
        snapshotId: body.snapshotId || null,
      };
    }
    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      error: error?.name === 'AbortError' ? `GPTO executor timed out after ${timeoutMs}ms` : error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function finishJob(job, result) {
  const sql = db();
  const maxAttempts = Math.max(1, Number(process.env.DATAFORSEO_AUTOMATION_MAX_ATTEMPTS || 3));
  if (result.ok) {
    await sql`
      UPDATE dataforseo_automation_jobs
      SET status = 'succeeded', snapshot_id = ${result.body.snapshotId}::uuid,
          process_summary = ${sql.json({ ingestLog: result.body.ingestLog || [], fromCache: result.body.fromCache === true })},
          cost = ${Number(result.body.cost || 0)}, error = NULL, locked_by = NULL, locked_at = NULL,
          finished_at = now(), updated_at = now()
      WHERE id = ${job.id}::uuid
    `;
    await invalidateCompletedSiteCache(sql, job);
  } else if (result.retryable && job.attempts < maxAttempts) {
    const delays = [60, 300, 1200];
    const delaySeconds = delays[Math.min(job.attempts - 1, delays.length - 1)];
    await sql`
      UPDATE dataforseo_automation_jobs
      SET status = 'pending', next_attempt_at = now() + (${delaySeconds} * interval '1 second'),
          snapshot_id = COALESCE(${result.snapshotId || null}::uuid, snapshot_id),
          error = ${String(result.error).slice(0, 2000)}, locked_by = NULL, locked_at = NULL, updated_at = now()
      WHERE id = ${job.id}::uuid
    `;
  } else {
    await sql`
      UPDATE dataforseo_automation_jobs
      SET status = 'failed', snapshot_id = COALESCE(${result.snapshotId || null}::uuid, snapshot_id),
          error = ${String(result.error).slice(0, 2000)}, locked_by = NULL, locked_at = NULL,
          finished_at = now(), updated_at = now()
      WHERE id = ${job.id}::uuid
    `;
  }
  await updateBatchTotals(sql, job.batch_id);
  return { jobId: job.id, endpoint: job.endpoint, siteId: job.site_id, ...result };
}

export async function runDataForSeoAutomationWorker() {
  requireEnabled();
  const concurrency = Math.max(1, Math.min(Number(process.env.DATAFORSEO_AUTOMATION_CONCURRENCY || 2), 5));
  const claimLimit = Math.max(1, Math.min(Number(process.env.DATAFORSEO_AUTOMATION_CLAIM_LIMIT || concurrency), concurrency));
  const jobs = await claimJobs(claimLimit);
  const results = await Promise.all(
    jobs.map(async (job) => finishJob(job, await executeJob(job)))
  );
  return { ok: true, claimed: jobs.length, concurrency, results };
}
