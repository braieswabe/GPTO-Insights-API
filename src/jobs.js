import os from 'node:os';
import { db } from './db.js';
import { EMPTY_SITE_UUID, MODEL_VERSION } from './types.js';

export const MAX_REFRESH_ATTEMPTS = 3;
export const STALE_LOCK_SECONDS = 6 * 60;
export const DASHBOARD_REFRESH_JOB_TIMEOUT_MS = 4 * 60 * 1000;

export class DashboardRefreshJobTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Dashboard refresh job timed out after ${timeoutMs}ms`);
    this.name = 'DashboardRefreshJobTimeoutError';
    this.timeoutMs = timeoutMs;
    this.retryable = true;
    this.statusCode = 408;
  }
}

export function refreshCooldownSeconds() {
  return Number(process.env.DASHBOARD_REFRESH_COOLDOWN_SECONDS || 300);
}

export function refreshJobSiteIdValue(identity) {
  return identity.siteId || null;
}

export function dashboardRefreshPriority(moduleKey) {
  // The worker claims lower numeric priorities first. Keep the composed
  // frontend read model and its telemetry/Top Pages input ahead of the wider
  // hourly prewarm fan-out so user-facing data cannot starve in the queue.
  if (moduleKey === 'overview') return 10;
  if (moduleKey === 'telemetry') return 20;
  return 100;
}

export function dashboardRefreshEffectivePriority(job) {
  const storedPriority = Number.isFinite(Number(job?.priority)) ? Number(job.priority) : 100;
  if (job?.module_key === 'overview') return Math.min(storedPriority, 10);
  // Give new telemetry work an early slot because overview consumes it, but do
  // not let a repeatedly timing-out telemetry job starve the rest of the queue.
  if (job?.module_key === 'telemetry' && Number(job?.attempts || 0) === 0) {
    return Math.min(storedPriority, 20);
  }
  return storedPriority;
}

export async function enqueueRefreshJob(identity, options = {}) {
  const sql = db();
  const cooldownSeconds = options.cooldownSeconds ?? refreshCooldownSeconds();

  const active = await sql`
    SELECT id, status
    FROM dashboard_refresh_jobs
    WHERE portal_scope = ${identity.portalScope}
      AND module_key = ${identity.moduleKey}
      AND COALESCE(site_id, ${EMPTY_SITE_UUID}::uuid) = COALESCE(${identity.siteId}::uuid, ${EMPTY_SITE_UUID}::uuid)
      AND range_key = ${identity.rangeKey}
      AND params_hash = ${identity.paramsHash}
      AND status IN ('pending', 'running')
    LIMIT 1
  `;
  if (active[0]) {
    return { queued: false, reason: 'active_job_exists', jobId: active[0].id };
  }

  const recent = await sql`
    SELECT id, status, requested_at, finished_at
    FROM dashboard_refresh_jobs
    WHERE portal_scope = ${identity.portalScope}
      AND module_key = ${identity.moduleKey}
      AND COALESCE(site_id, ${EMPTY_SITE_UUID}::uuid) = COALESCE(${identity.siteId}::uuid, ${EMPTY_SITE_UUID}::uuid)
      AND range_key = ${identity.rangeKey}
      AND params_hash = ${identity.paramsHash}
    ORDER BY requested_at DESC
    LIMIT 1
  `;
  if (recent[0]) {
    const latestTime = new Date(recent[0].finished_at || recent[0].requested_at).getTime();
    if (Date.now() - latestTime < cooldownSeconds * 1000 && ['failed', 'pending'].includes(recent[0].status)) {
      return { queued: false, reason: 'cooldown', jobId: recent[0].id };
    }
  }

  const siteIdValue = refreshJobSiteIdValue(identity);
  const rows = await sql`
    INSERT INTO dashboard_refresh_jobs (
      site_id, portal_scope, module_key, range_key,
      params, params_hash, status, priority, requested_by, model_version, next_attempt_at
    )
    VALUES (
      ${siteIdValue}::uuid, ${identity.portalScope}, ${identity.moduleKey},
      ${identity.rangeKey}, ${sql.json(identity.params || {})},
      ${identity.paramsHash}, 'pending', ${options.priority ?? dashboardRefreshPriority(identity.moduleKey)},
      ${options.requestedBy || null}, ${MODEL_VERSION}, now()
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (rows[0]) return { queued: true, reason: 'queued', jobId: rows[0].id };

  const [deduplicated] = await sql`
    SELECT id, status
    FROM dashboard_refresh_jobs
    WHERE portal_scope = ${identity.portalScope}
      AND module_key = ${identity.moduleKey}
      AND COALESCE(site_id, ${EMPTY_SITE_UUID}::uuid) = COALESCE(${identity.siteId}::uuid, ${EMPTY_SITE_UUID}::uuid)
      AND range_key = ${identity.rangeKey}
      AND params_hash = ${identity.paramsHash}
      AND status IN ('pending', 'running')
    ORDER BY requested_at ASC
    LIMIT 1
  `;
  return { queued: false, reason: 'active_job_exists', jobId: deduplicated?.id || null };
}

export function dashboardRefreshWorkerBatchSize() {
  // Dashboard modules can each take several minutes. Claiming exactly one keeps
  // later jobs from being abandoned when an earlier module consumes the Vercel budget.
  return 1;
}

export function shouldRetryDashboardRefreshJob(error, attempts) {
  return retryableDashboardRefreshError(error) && Number(attempts || 0) < MAX_REFRESH_ATTEMPTS;
}

export async function withDashboardRefreshJobDeadline(operation, timeoutMs = DASHBOARD_REFRESH_JOB_TIMEOUT_MS) {
  const boundedTimeoutMs = Math.max(5_000, Math.min(DASHBOARD_REFRESH_JOB_TIMEOUT_MS, Number(timeoutMs) || DASHBOARD_REFRESH_JOB_TIMEOUT_MS));
  let timer = null;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DashboardRefreshJobTimeoutError(boundedTimeoutMs)), boundedTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function failExhaustedRefreshJobs() {
  const sql = db();
  const rows = await sql`
    UPDATE dashboard_refresh_jobs
    SET status = 'failed',
        locked_by = NULL,
        locked_at = NULL,
        finished_at = now(),
        updated_at = now(),
        error = COALESCE(error, 'Dashboard refresh exceeded the maximum execution attempts')
    WHERE attempts >= ${MAX_REFRESH_ATTEMPTS}
      AND (
        status = 'pending'
        OR (
          status = 'running'
          AND (locked_at IS NULL OR locked_at < now() - (${STALE_LOCK_SECONDS} * interval '1 second'))
        )
      )
    RETURNING id
  `;
  return rows.length;
}

export async function claimRefreshJobs(limit = 1) {
  const sql = db();
  const workerId = `${os.hostname()}:${process.pid}`;
  await failExhaustedRefreshJobs();
  await sql`
    UPDATE dashboard_refresh_jobs
    SET status = 'pending', locked_by = NULL, locked_at = NULL,
        next_attempt_at = now(), error = 'Recovered stale worker lock', updated_at = now()
    WHERE status = 'running'
      AND attempts < ${MAX_REFRESH_ATTEMPTS}
      AND (locked_at IS NULL OR locked_at < now() - (${STALE_LOCK_SECONDS} * interval '1 second'))
  `;
  return sql.begin(async (tx) => {
    const rows = await tx`
      SELECT *
      FROM dashboard_refresh_jobs
      WHERE status = 'pending'
        AND attempts < ${MAX_REFRESH_ATTEMPTS}
        AND next_attempt_at <= now()
      ORDER BY
        CASE
          WHEN module_key = 'overview' THEN LEAST(priority, 10)
          WHEN module_key = 'telemetry' AND attempts = 0 THEN LEAST(priority, 20)
          ELSE priority
        END ASC,
        CASE WHEN attempts = 0 THEN 0 ELSE 1 END ASC,
        requested_at ASC
      LIMIT ${dashboardRefreshWorkerBatchSize(limit)}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await tx`
      UPDATE dashboard_refresh_jobs
      SET status = 'running',
          attempts = attempts + 1,
          locked_by = ${workerId},
          locked_at = now(),
          started_at = now(),
          updated_at = now(),
          error = NULL
      WHERE id = ANY(${ids}::uuid[])
    `;
    return rows.map((r) => ({
      ...r,
      attempts: Number(r.attempts || 0) + 1,
      status: 'running',
      locked_by: workerId,
    }));
  });
}

export function dashboardRefreshRetryDelaySeconds(attempts) {
  return Math.min(15 * 60, 30 * (2 ** Math.max(0, Number(attempts || 1) - 1)));
}

export function retryableDashboardRefreshError(error) {
  const statusCode = Number(error?.statusCode || error?.status || 0);
  return !statusCode || statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
}

export async function completeRefreshJob(job, result) {
  const sql = db();
  const jobId = typeof job === 'string' ? job : job.id;
  const attempts = typeof job === 'string' ? MAX_REFRESH_ATTEMPTS : Number(job.attempts || 0);
  const shouldRetry = !result.ok && result.retryable === true && attempts < MAX_REFRESH_ATTEMPTS;
  const lockedBy = typeof job === 'string' ? null : job.locked_by || null;
  await sql`
    UPDATE dashboard_refresh_jobs
    SET status = ${result.ok ? 'succeeded' : shouldRetry ? 'pending' : 'failed'},
        next_attempt_at = ${shouldRetry ? new Date(Date.now() + dashboardRefreshRetryDelaySeconds(attempts) * 1000) : new Date()},
        locked_by = NULL,
        locked_at = NULL,
        finished_at = ${result.ok || !shouldRetry ? new Date() : null},
        updated_at = now(),
        error = ${result.ok ? null : result.error || 'Refresh failed'}
    WHERE id = ${jobId}
      AND status = 'running'
      AND (${lockedBy}::text IS NULL OR locked_by = ${lockedBy})
  `;
  return result.ok ? 'succeeded' : shouldRetry ? 'pending' : 'failed';
}

export async function getRefreshJobStatuses(jobIds) {
  if (!Array.isArray(jobIds) || jobIds.length === 0) return [];
  const sql = db();
  return sql`
    SELECT id, status, portal_scope, module_key, range_key, attempts, error,
           updated_at, finished_at
    FROM dashboard_refresh_jobs
    WHERE id = ANY(${jobIds}::uuid[])
  `;
}
