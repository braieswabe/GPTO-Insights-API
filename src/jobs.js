import os from 'node:os';
import { db } from './db.js';
import { EMPTY_SITE_UUID, MODEL_VERSION } from './types.js';

export function refreshCooldownSeconds() {
  return Number(process.env.DASHBOARD_REFRESH_COOLDOWN_SECONDS || 300);
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

  const siteIdValue = identity.siteId || EMPTY_SITE_UUID;
  const rows = await sql`
    INSERT INTO dashboard_refresh_jobs (
      site_id, portal_scope, module_key, range_key,
      params, params_hash, status, priority, requested_by, model_version
    )
    VALUES (
      ${siteIdValue}::uuid, ${identity.portalScope}, ${identity.moduleKey},
      ${identity.rangeKey}, ${sql.json(identity.params || {})},
      ${identity.paramsHash}, 'pending', ${options.priority ?? 100},
      ${options.requestedBy || null}, ${MODEL_VERSION}
    )
    RETURNING id
  `;
  return { queued: true, reason: 'queued', jobId: rows[0]?.id || null };
}

export async function claimRefreshJobs(limit = 3) {
  const sql = db();
  const workerId = `${os.hostname()}:${process.pid}`;
  return sql.begin(async (tx) => {
    const rows = await tx`
      SELECT *
      FROM dashboard_refresh_jobs
      WHERE status = 'pending'
      ORDER BY priority ASC, requested_at ASC
      LIMIT ${limit}
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
    return rows.map((r) => ({ ...r, status: 'running', locked_by: workerId }));
  });
}

export async function completeRefreshJob(jobId, result) {
  const sql = db();
  await sql`
    UPDATE dashboard_refresh_jobs
    SET status = ${result.ok ? 'succeeded' : 'failed'},
        finished_at = now(),
        updated_at = now(),
        error = ${result.ok ? null : result.error || 'Refresh failed'}
    WHERE id = ${jobId}
  `;
}
