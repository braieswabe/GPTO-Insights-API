import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import {
  dataForSeoDeferralNextAttempt,
  isDataForSeoDeferral,
  manilaScheduleKey,
} from './dataforseo-automation.js';

export const LLM_RESPONSES_PLATFORMS = ['chat_gpt', 'claude', 'gemini', 'perplexity'];

export const DEFAULT_LLM_RESPONSES_MODELS = {
  chat_gpt: 'gpt-4.1-mini',
  claude: 'claude-haiku-4-5',
  gemini: 'gemini-2.5-flash-lite',
  perplexity: 'sonar',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS = 3;

export function isLlmResponsesPlatform(value) {
  return LLM_RESPONSES_PLATFORMS.includes(value);
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clampPrompts(value, fallback) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(25, Math.max(1, parsed));
}

function asPlatformList(value) {
  const raw = Array.isArray(value) ? value : [];
  return raw.filter(isLlmResponsesPlatform);
}

function asModels(value) {
  const models = { ...DEFAULT_LLM_RESPONSES_MODELS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return models;
  for (const platform of LLM_RESPONSES_PLATFORMS) {
    const name = value[platform];
    if (typeof name === 'string' && name.trim()) models[platform] = name.trim();
  }
  return models;
}

async function loadConfig(sql) {
  const [row] = await sql`
    SELECT llm_responses_enabled AS enabled,
      llm_responses_platforms AS platforms,
      llm_responses_models AS models,
      llm_responses_prompts_per_platform AS prompts_per_platform
    FROM automation_system_config
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  `;
  return {
    enabled: row ? row.enabled !== false : true,
    platforms: asPlatformList(row?.platforms).length ? asPlatformList(row.platforms) : [...LLM_RESPONSES_PLATFORMS],
    models: asModels(row?.models),
    promptsPerPlatform: clampPrompts(row?.prompts_per_platform, 3),
  };
}

async function insertJobs(tx, { batchId, platform, modelName, promptsPerPlatform, siteId = null }) {
  const siteClause = siteId ? tx`AND site.id = ${siteId}::uuid` : tx``;
  const jobs = await tx`
    WITH deduped AS (
      SELECT DISTINCT ON (prompt.site_id, lower(btrim(prompt.query)))
        prompt.id,
        prompt.site_id,
        btrim(prompt.query) AS query,
        prompt.priority,
        prompt.created_at
      FROM llm_mentions_tracked_prompts prompt
      JOIN sites site ON site.id = prompt.site_id
      WHERE prompt.active = true
        AND site.status = 'active'
        AND char_length(btrim(prompt.query)) BETWEEN 1 AND 500
        ${siteClause}
        AND NOT EXISTS (
          SELECT 1
          FROM dataforseo_site_automation_config site_config
          WHERE site_config.site_id = site.id
            AND site_config.enabled = false
        )
      ORDER BY prompt.site_id, lower(btrim(prompt.query)),
        CASE lower(coalesce(prompt.priority, 'medium')) WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
        prompt.created_at, prompt.id
    ),
    ranked AS (
      SELECT deduped.*,
        row_number() OVER (
          PARTITION BY deduped.site_id
          ORDER BY CASE lower(coalesce(deduped.priority, 'medium')) WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
            deduped.created_at, deduped.id
        ) AS rank
      FROM deduped
    )
    INSERT INTO llm_responses_jobs (batch_id, site_id, platform, prompt_id, prompt_text, model_name, status)
    SELECT ${batchId}::uuid, ranked.site_id, ${platform}, ranked.id, ranked.query, ${modelName}, 'pending'
    FROM ranked
    WHERE ranked.rank <= ${promptsPerPlatform}
    ON CONFLICT (batch_id, site_id, platform, md5(prompt_text)) DO NOTHING
    RETURNING id
  `;
  return jobs.length;
}

async function syncBatchTotals(tx, batchId) {
  await tx`
    UPDATE llm_responses_batches batch
    SET total_jobs = counts.total, updated_at = now()
    FROM (
      SELECT count(*)::int AS total
      FROM llm_responses_jobs
      WHERE batch_id = ${batchId}::uuid
    ) counts
    WHERE batch.id = ${batchId}::uuid
  `;
}

export async function refreshLlmResponsesBatch(batchId, sql = db()) {
  await sql`
    UPDATE llm_responses_batches batch
    SET succeeded_jobs = counts.succeeded,
        failed_jobs = counts.failed,
        total_jobs = counts.total,
        status = CASE
          WHEN counts.active > 0 THEN 'running'
          WHEN counts.failed > 0 AND counts.succeeded > 0 THEN 'partially_failed'
          WHEN counts.failed > 0 THEN 'failed'
          ELSE 'succeeded'
        END,
        started_at = coalesce(batch.started_at, counts.started_at),
        finished_at = CASE WHEN counts.active = 0 THEN now() ELSE NULL END,
        updated_at = now()
    FROM (
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status IN ('pending', 'retry', 'running'))::int AS active,
        min(started_at) AS started_at
      FROM llm_responses_jobs
      WHERE batch_id = ${batchId}::uuid
    ) counts
    WHERE batch.id = ${batchId}::uuid
  `;
}

export async function enqueueScheduledLlmResponses(options = {}) {
  const sql = db();
  const scheduleKey = options.scheduleKey || manilaScheduleKey(options.now);
  const config = await loadConfig(sql);
  if (!config.enabled) {
    return { ok: true, skipped: true, reason: 'disabled', scheduleKey, batches: [] };
  }
  const batches = [];
  for (const platform of config.platforms) {
    const batch = await sql.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO llm_responses_batches (trigger, schedule_key, platform, status)
        VALUES ('scheduled', ${scheduleKey}, ${platform}, 'queued')
        ON CONFLICT (schedule_key, platform) WHERE schedule_key IS NOT NULL DO NOTHING
        RETURNING id
      `;
      const [existing] = inserted.length
        ? inserted
        : await tx`
            SELECT id FROM llm_responses_batches
            WHERE schedule_key = ${scheduleKey} AND platform = ${platform}
            LIMIT 1
          `;
      if (!existing?.id) throw httpError(`Could not create LLM Responses ${platform} batch`, 500);
      const insertedJobs = await insertJobs(tx, {
        batchId: existing.id,
        platform,
        modelName: config.models[platform],
        promptsPerPlatform: config.promptsPerPlatform,
      });
      await syncBatchTotals(tx, existing.id);
      return { id: existing.id, platform, insertedJobs };
    });
    batches.push(batch);
  }
  return { ok: true, skipped: false, scheduleKey, batches };
}

export async function enqueueManualLlmResponses(body = {}) {
  const sql = db();
  const config = await loadConfig(sql);
  const siteId = typeof body.siteId === 'string' && UUID_RE.test(body.siteId.trim()) ? body.siteId.trim() : null;
  if (body.siteId && !siteId) throw httpError('siteId must be a UUID', 400);
  if (siteId) {
    const [site] = await sql`
      SELECT site.id, site.domain, site.status, site_config.enabled AS automation_enabled
      FROM sites site
      LEFT JOIN dataforseo_site_automation_config site_config ON site_config.site_id = site.id
      WHERE site.id = ${siteId}::uuid
      LIMIT 1
    `;
    if (!site || site.status !== 'active') throw httpError('Active site not found', 404);
    if (site.automation_enabled === false) {
      throw httpError('DataForSEO automation is disabled for this site in Settings', 409);
    }
  }
  const requested = asPlatformList(body.platforms);
  const platforms = requested.length ? requested : config.platforms;
  const promptsPerPlatform = body.promptsPerPlatform == null
    ? config.promptsPerPlatform
    : clampPrompts(body.promptsPerPlatform, config.promptsPerPlatform);
  const requestedBy = UUID_RE.test(String(body.requestedBy || '')) ? String(body.requestedBy) : null;
  const batches = [];
  for (const platform of platforms) {
    const batch = await sql.begin(async (tx) => {
      const [created] = await tx`
        INSERT INTO llm_responses_batches (trigger, platform, status, requested_by)
        VALUES ('manual', ${platform}, 'queued', ${requestedBy}::uuid)
        RETURNING id
      `;
      if (!created?.id) throw httpError(`Could not create LLM Responses ${platform} manual batch`, 500);
      const insertedJobs = await insertJobs(tx, {
        batchId: created.id,
        platform,
        modelName: config.models[platform],
        promptsPerPlatform,
        siteId,
      });
      await syncBatchTotals(tx, created.id);
      return { id: created.id, platform, insertedJobs };
    });
    batches.push(batch);
  }
  return {
    ok: true,
    siteId,
    batchId: batches[0]?.id ?? null,
    batchIds: batches.map((batch) => batch.id),
    batches,
  };
}

export async function getLlmResponsesBatch(batchId) {
  if (!UUID_RE.test(String(batchId || ''))) throw httpError('batchId must be a UUID', 400);
  const sql = db();
  const [batch] = await sql`
    SELECT id, trigger, schedule_key AS "scheduleKey", platform, status,
      requested_by AS "requestedBy", total_jobs AS "totalJobs",
      succeeded_jobs AS "succeededJobs", failed_jobs AS "failedJobs",
      created_at AS "createdAt", started_at AS "startedAt",
      finished_at AS "finishedAt", updated_at AS "updatedAt"
    FROM llm_responses_batches
    WHERE id = ${batchId}::uuid
    LIMIT 1
  `;
  if (!batch) throw httpError('LLM Responses batch not found', 404);
  const jobs = await sql`
    SELECT job.id, job.batch_id AS "batchId", job.site_id AS "siteId", site.domain, job.platform,
      job.prompt_id AS "promptId", job.prompt_text AS "promptText", job.model_name AS "modelName",
      job.status, job.attempts, job.result_id AS "resultId", job.cost, job.error,
      result.site_cited AS "siteCited", result.site_mentioned AS "siteMentioned"
    FROM llm_responses_jobs job
    JOIN sites site ON site.id = job.site_id
    LEFT JOIN llm_responses_results result ON result.id = job.result_id
    WHERE job.batch_id = ${batchId}::uuid
    ORDER BY site.domain, job.created_at, job.prompt_text
  `;
  const succeeded = jobs.filter((job) => job.status === 'succeeded').length;
  const failed = jobs.filter((job) => job.status === 'failed').length;
  return {
    ...batch,
    counts: { total: jobs.length, succeeded, failed, active: jobs.length - succeeded - failed },
    jobs,
  };
}

export async function retryLlmResponsesBatch(batchId) {
  await getLlmResponsesBatch(batchId);
  const sql = db();
  const reset = await sql`
    UPDATE llm_responses_jobs
    SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_by = NULL,
      locked_at = NULL, error = NULL, finished_at = NULL, updated_at = now()
    WHERE batch_id = ${batchId}::uuid AND status IN ('failed', 'retry')
    RETURNING id
  `;
  if (reset.length) {
    await sql`
      UPDATE llm_responses_batches
      SET status = 'queued', failed_jobs = 0, finished_at = NULL, updated_at = now()
      WHERE id = ${batchId}::uuid
    `;
  }
  return { ok: true, batchId, resetJobs: reset.length };
}

async function claimJobs(limit, workerId) {
  const sql = db();
  return sql`
    WITH selected AS (
      SELECT job.id
      FROM llm_responses_jobs job
      WHERE (job.status IN ('pending', 'retry') AND job.next_attempt_at <= now())
         OR (job.status = 'running' AND job.locked_at < now() - interval '5 minutes')
      ORDER BY job.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE llm_responses_jobs job
    SET status = 'running', attempts = job.attempts + 1, locked_by = ${workerId},
        locked_at = now(), started_at = coalesce(job.started_at, now()), error = NULL, updated_at = now()
    FROM selected, llm_responses_batches batch
    WHERE job.id = selected.id AND batch.id = job.batch_id
    RETURNING job.id, job.batch_id AS "batchId", job.site_id AS "siteId", job.platform,
      job.prompt_id AS "promptId", job.prompt_text AS "promptText", job.model_name AS "modelName",
      job.attempts, batch.trigger, batch.schedule_key AS "scheduleKey"
  `;
}

function retryDelaySeconds(attempts) {
  return Math.min(900, 30 * (2 ** Math.max(0, attempts - 1)));
}

async function recordOutcome(job, outcome) {
  const sql = db();
  if (outcome.kind === 'deferred') {
    const nextAttempt = dataForSeoDeferralNextAttempt(outcome);
    await sql`
      UPDATE llm_responses_jobs
      SET status = 'pending', attempts = greatest(0, attempts - 1),
          next_attempt_at = ${nextAttempt},
          locked_by = NULL, locked_at = NULL, error = ${outcome.message}, updated_at = now()
      WHERE id = ${job.id}::uuid
    `;
  } else if (outcome.kind === 'failed') {
    const retryable = outcome.retryable && job.attempts < MAX_ATTEMPTS;
    const delay = retryDelaySeconds(job.attempts);
    await sql`
      UPDATE llm_responses_jobs
      SET status = ${retryable ? 'retry' : 'failed'},
          next_attempt_at = now() + (${delay} * interval '1 second'),
          locked_by = NULL, locked_at = NULL, error = ${outcome.message},
          finished_at = CASE WHEN ${retryable} THEN NULL ELSE now() END, updated_at = now()
      WHERE id = ${job.id}::uuid
    `;
  } else {
    const resultId = typeof outcome.body?.resultId === 'string' ? outcome.body.resultId : null;
    await sql`
      UPDATE llm_responses_jobs
      SET status = 'succeeded', result_id = ${resultId}::uuid,
          cost = ${Number(outcome.body?.cost || 0)}, error = NULL,
          locked_by = NULL, locked_at = NULL, finished_at = now(), updated_at = now()
      WHERE id = ${job.id}::uuid
    `;
  }
  await refreshLlmResponsesBatch(job.batchId, sql);
  if (outcome.kind === 'failed') return outcome.retryable && job.attempts < MAX_ATTEMPTS ? 'retried' : 'failed';
  return outcome.kind === 'deferred' ? 'deferred' : 'succeeded';
}

async function executeJob(job) {
  const base = process.env.GPTO_DASHBOARD_BASE_URL?.replace(/\/+$/, '');
  const token = process.env.GPTO_DATAFORSEO_AUTOMATION_TOKEN;
  if (!base || !token) {
    return { kind: 'failed', retryable: false, message: 'GPTO dashboard automation endpoint is not configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 170_000);
  try {
    const response = await fetch(`${base}/api/internal/llm-responses/execute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id,
        batchId: job.batchId,
        siteId: job.siteId,
        platform: job.platform,
        promptId: job.promptId,
        promptText: job.promptText,
        modelName: job.modelName,
        trigger: job.trigger === 'manual' ? 'manual' : 'scheduled',
        scheduleKey: job.scheduleKey,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok && isDataForSeoDeferral({ ...body, ok: false, retryable: body.retryable === true })) {
      return {
        kind: 'deferred',
        retryable: true,
        code: body.code,
        retryAfterSeconds: Number(body.retryAfterSeconds || response.headers.get('retry-after') || 90),
        retryAfterAt: body.retryAfterAt || null,
        message: String(body.message || body.error || body.code || 'deferred'),
      };
    }
    if (!response.ok) {
      return {
        kind: 'failed',
        retryable: body.retryable === true,
        message: String(body.message || body.error || `Dashboard executor failed (${response.status})`).slice(0, 2000),
      };
    }
    return { kind: 'succeeded', body };
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Dashboard executor timed out after 170s' : error?.message || String(error);
    return { kind: 'failed', retryable: true, message };
  } finally {
    clearTimeout(timer);
  }
}

export async function processLlmResponsesJobs(limit = 1) {
  const bounded = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(Number(limit), 2)) : 1;
  const jobs = await claimJobs(bounded, `llm-responses:${randomUUID()}`);
  const counts = { claimed: jobs.length, succeeded: 0, deferred: 0, retried: 0, failed: 0 };
  for (const job of jobs) {
    const outcome = await executeJob(job);
    const recorded = await recordOutcome(job, outcome);
    counts[recorded] += 1;
  }
  return counts;
}
