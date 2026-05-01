import { assertSiteAccess, getUserContext } from '../access.js';
import { buildCacheIdentity, getCacheRow, isCacheStale, serializeCacheRow, upsertCacheRow } from '../cache.js';
import { claimRefreshJobs, completeRefreshJob, enqueueRefreshJob } from '../jobs.js';
import { computedFreshness, missingFreshness, ok, responseEnvelope } from '../contracts.js';
import { buildDashboardOverview, buildModule, buildLlmMentionsOverview } from '../builders/index.js';
import { buildDashboardStats, buildGoldDashboard } from '../builders/gold.js';
import { DASHBOARD_MODULES, normalizePortal, normalizeRange, rangeToDays, ttlForModule } from '../types.js';

export function emptyDashboardOverview() {
  return {
    sites: 0,
    sitesList: [],
    telemetry: null,
    confusion: null,
    authority: null,
    schema: null,
    coverage: null,
    dashboardIndex: [],
    llmAiVisibilityIndex: null,
    executiveSummary: null,
    journey: null,
    searchDiagnostics: null,
    experience: null,
    aiReadability: null,
    llmMentions: null,
  };
}

function cacheMetadata(row) {
  const serialized = serializeCacheRow(row);
  return serialized?.metadata || missingFreshness();
}

function cacheEnvelope(row, refresh, moduleKey, fallback = null) {
  const serialized = serializeCacheRow(row);
  const freshness = cacheMetadata(row);
  return responseEnvelope({
    key: moduleKey,
    data: serialized?.payload ?? fallback,
    freshness,
    stale: !row || isCacheStale(row),
    refresh,
    generatedAt: freshness.generatedAt,
  });
}

function cacheIdentity({ portalScope, moduleKey, siteId, rangeKey, params = {} }) {
  return buildCacheIdentity({ portalScope, moduleKey, siteId, rangeKey, params });
}

async function enqueueIfStale(row, identity, request) {
  if (row && !isCacheStale(row)) return { queued: false, reason: 'fresh_cache', jobId: null };
  try {
    const user = getUserContext(request);
    return await enqueueRefreshJob(identity, { requestedBy: user.userId, priority: row ? 0 : 5 });
  } catch (error) {
    console.error('enqueueRefreshJob failed (non-fatal):', error?.message || error);
    return { queued: false, reason: 'enqueue_error', jobId: null };
  }
}

export function parseDashboardContext(request, { customerDefault = false } = {}) {
  const search = request.url.searchParams;
  return {
    siteId: search.get('siteId') || null,
    portalScope: normalizePortal(search.get('portal') || (customerDefault ? 'customer' : null)),
    rangeKey: normalizeRange(search.get('range')),
    user: getUserContext(request),
  };
}

export async function readDashboardOverview(request) {
  const context = parseDashboardContext(request);
  await assertSiteAccess(context);

  const identity = cacheIdentity({
    ...context,
    moduleKey: 'overview',
    params: { portalScope: context.portalScope },
  });
  const row = await getCacheRow(identity);
  if (row && !isCacheStale(row)) return ok(cacheEnvelope(row, null, 'overview', emptyDashboardOverview()));

  try {
    const payload = await buildDashboardOverview(context);
    upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule('overview') }).catch(() => {});
    return ok(responseEnvelope({ key: 'overview', data: payload, freshness: computedFreshness() }));
  } catch (error) {
    console.error('buildDashboardOverview failed:', error?.message || error);
    if (row) return ok(cacheEnvelope(row, await enqueueIfStale(row, identity, request), 'overview', emptyDashboardOverview()));
    return ok(cacheEnvelope(null, { queued: false, reason: 'build_failed', jobId: null }, 'overview', emptyDashboardOverview()));
  }
}

export async function readDashboardModule(request, moduleKey) {
  const context = parseDashboardContext(request);
  if (!DASHBOARD_MODULES.includes(moduleKey)) {
    return { status: 404, body: { error: `Unsupported module: ${moduleKey}` } };
  }
  await assertSiteAccess(context);

  const identity = cacheIdentity({
    ...context,
    moduleKey,
    params: { portalScope: context.portalScope },
  });
  const row = await getCacheRow(identity);
  if (row && !isCacheStale(row)) return ok(cacheEnvelope(row, null, moduleKey));

  try {
    const payload = await buildModule(moduleKey, context);
    upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(moduleKey) }).catch(() => {});
    return ok(responseEnvelope({ key: moduleKey, data: payload, freshness: computedFreshness() }));
  } catch (error) {
    console.error(`buildModule(${moduleKey}) failed:`, error?.message || error);
    if (row) return ok(cacheEnvelope(row, await enqueueIfStale(row, identity, request), moduleKey));
    return ok(cacheEnvelope(null, { queued: false, reason: 'build_failed', jobId: null }, moduleKey));
  }
}

export async function readDashboardGold(request) {
  const context = parseDashboardContext(request, { customerDefault: true });
  if (!context.siteId) return { status: 400, body: { error: 'siteId is required' } };
  await assertSiteAccess(context);
  return ok(await buildGoldDashboard(context));
}

export async function readDashboardStats(request) {
  const context = parseDashboardContext(request);
  await assertSiteAccess(context);
  return ok(await buildDashboardStats(context));
}

export async function readDashboardExportData(request) {
  const context = parseDashboardContext(request);
  await assertSiteAccess(context);
  const [telemetry, confusion, authority, schema, coverage, index, executive, llmMentions] = await Promise.all([
    buildModule('telemetry', context),
    buildModule('confusion', context),
    buildModule('authority', context),
    buildModule('schema', context),
    buildModule('coverage', context),
    buildModule('index', context),
    buildModule('executive_summary', context),
    context.siteId
      ? buildLlmMentionsOverview({ siteId: context.siteId, days: rangeToDays(context.rangeKey), sources: ['chat_gpt', 'google_ai_overviews'] }).catch(() => null)
      : Promise.resolve(null),
  ]);
  return ok({
    generatedAt: new Date().toISOString(),
    range: context.rangeKey,
    telemetry,
    confusion,
    authority,
    schema,
    coverage,
    index,
    executive,
    llmMentions,
  });
}

export async function refreshDashboard(request, body) {
  if (body.processQueued === true) return processRefreshJobs(body);

  const siteId = body.siteId || null;
  const portalScope = normalizePortal(body.portalScope || body.portal);
  const rangeKey = normalizeRange(body.range);
  const user = getUserContext(request);
  await assertSiteAccess({ siteId, portalScope, user });

  const modules = Array.isArray(body.modules) && body.modules.length > 0
    ? body.modules
    : ['telemetry', 'authority', 'executive_summary', 'experience', 'search_diagnostics', 'confusion', 'coverage'];

  const results = [];
  for (const moduleKey of modules.filter((key) => DASHBOARD_MODULES.includes(key) && key !== 'overview')) {
    const identity = cacheIdentity({ portalScope, moduleKey, siteId, rangeKey, params: { portalScope } });
    const payload = await buildModule(moduleKey, { siteId, rangeKey, portalScope });
    await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(moduleKey) });
    results.push({ moduleKey, ok: true });
  }

  const overviewIdentity = cacheIdentity({ portalScope, moduleKey: 'overview', siteId, rangeKey, params: { portalScope } });
  const overview = await buildDashboardOverview({ siteId, rangeKey, portalScope });
  await upsertCacheRow(overviewIdentity, overview, { ttlSeconds: ttlForModule('overview') });
  results.push({ moduleKey: 'overview', ok: true });

  return ok({ ok: true, siteId, portalScope, range: rangeKey, results });
}

export async function processRefreshJobs(body = {}) {
  const limit = Math.max(1, Math.min(Number(body.limit || 5), 10));
  const jobs = await claimRefreshJobs(limit);
  const results = [];

  for (const job of jobs) {
    try {
      const identity = {
        portalScope: job.portal_scope,
        moduleKey: job.module_key,
        siteId: job.site_id,
        rangeKey: job.range_key,
        params: job.params || {},
        paramsHash: job.params_hash,
        modelVersion: job.model_version,
      };
      const payload =
        job.module_key === 'llm_mentions_overview'
          ? await buildLlmMentionsOverview({
              siteId: job.site_id,
              days: Number(job.params?.days || 7),
              sources: Array.isArray(job.params?.sources) ? job.params.sources : ['chat_gpt', 'google_ai_overviews'],
            })
          : await buildModule(job.module_key, {
              siteId: job.site_id,
              rangeKey: job.range_key,
              portalScope: job.portal_scope,
            });

      await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(job.module_key) });
      await completeRefreshJob(job.id, { ok: true });
      results.push({ jobId: job.id, moduleKey: job.module_key, ok: true });
    } catch (error) {
      await completeRefreshJob(job.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
      results.push({ jobId: job.id, moduleKey: job.module_key, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return ok({ ok: true, claimed: jobs.length, results });
}
