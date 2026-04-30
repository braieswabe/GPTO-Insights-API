import { requireInternalAuth, getUserContext, assertSiteAccess } from './access.js';
import { buildCacheIdentity, getCacheRow, isCacheStale, serializeCacheRow, upsertCacheRow } from './cache.js';
import { claimRefreshJobs, completeRefreshJob, enqueueRefreshJob } from './jobs.js';
import { buildDashboardOverview, buildModule, buildLlmMentionsOverview, buildLlmMentionsTrends, buildLlmMentionsCompetitors, buildLlmMentionsPromptIntelligence, buildLlmMentionsSourceGap } from './builders/index.js';
import { buildSitesList, buildSiteConfig } from './builders/sites.js';
import { DASHBOARD_MODULES, normalizePortal, normalizeRange, ttlForModule, rangeToDays } from './types.js';
import { readJson } from './http.js';

function requireAuthOrThrow(request) {
  const auth = requireInternalAuth(request);
  if (!auth.ok) {
    const error = new Error(auth.error);
    error.statusCode = auth.status;
    throw error;
  }
}

function cacheMetadata(row) {
  const serialized = serializeCacheRow(row);
  return serialized?.metadata || {
    status: 'missing',
    generatedAt: null,
    sourceWatermarkAt: null,
    expiresAt: null,
    stale: true,
    error: null,
  };
}

function emptyDashboardOverview() {
  return {
    sites: 0, sitesList: [], telemetry: null, confusion: null, authority: null,
    schema: null, coverage: null, dashboardIndex: [], llmAiVisibilityIndex: null,
    executiveSummary: null, journey: null, searchDiagnostics: null,
    experience: null, aiReadability: null, llmMentions: null,
  };
}

function dashboardOverviewResponseFromCache(row, refresh) {
  const serialized = serializeCacheRow(row);
  const freshness = cacheMetadata(row);
  return {
    data: serialized?.payload || emptyDashboardOverview(),
    freshness: { overview: freshness },
    generatedAt: freshness.generatedAt,
    stale: !row || isCacheStale(row),
    refreshQueued: refresh?.queued || false,
    refreshQueueReason: refresh?.reason || null,
    jobId: refresh?.jobId || null,
  };
}

function moduleResponseFromCache(row, refresh, moduleKey) {
  const serialized = serializeCacheRow(row);
  const freshness = cacheMetadata(row);
  return {
    data: serialized?.payload || null,
    freshness: { [moduleKey]: freshness },
    generatedAt: freshness.generatedAt,
    stale: !row || isCacheStale(row),
    refreshQueued: refresh?.queued || false,
    refreshQueueReason: refresh?.reason || null,
    jobId: refresh?.jobId || null,
  };
}

function llmOverviewResponseFromCache(row, refresh) {
  const serialized = serializeCacheRow(row);
  const freshness = cacheMetadata(row);
  const payload = serialized?.payload || null;
  const sourceRows = payload?.summary?.platformBreakdown || [];
  const sources = {};
  for (const item of sourceRows) {
    if (!item?.source) continue;
    sources[item.source] = item;
  }
  return {
    data: { sources, combined: payload },
    freshness: { llm_mentions_overview: freshness },
    generatedAt: freshness.generatedAt,
    stale: !row || isCacheStale(row),
    refreshQueued: refresh?.queued || false,
    refreshQueueReason: refresh?.reason || null,
    jobId: refresh?.jobId || null,
  };
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

export async function route(request) {
  const { method, url } = request;

  // Health & root
  if ((method === 'GET' || method === 'HEAD') && url.pathname === '/') {
    return { status: 200, body: { ok: true, service: 'gpto-insights-gateway', health: '/internal/health' } };
  }
  if ((method === 'GET' || method === 'HEAD') && url.pathname === '/favicon.ico') {
    return { status: 204, body: null };
  }
  if ((method === 'GET' || method === 'HEAD') && url.pathname === '/internal/health') {
    return { status: 200, body: { ok: true, service: 'gpto-insights-gateway', time: new Date().toISOString() } };
  }

  // Auth required for /v1/ and /internal/ (except health)
  if (url.pathname.startsWith('/internal/') || url.pathname.startsWith('/v1/')) {
    requireAuthOrThrow(request);
  }

  // Dashboard overview
  if (method === 'GET' && url.pathname === '/v1/dashboard/overview') {
    return handleDashboardOverviewGet(request);
  }

  // Dashboard module
  const moduleMatch = url.pathname.match(/^\/v1\/dashboard\/module\/([^/]+)$/);
  if (method === 'GET' && moduleMatch) {
    return handleDashboardModuleGet(request, moduleMatch[1]);
  }

  // LLM mentions endpoints
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/overview') {
    return handleLlmMentionsOverviewGet(request);
  }
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/trends') {
    return handleLlmMentionsTrendsGet(request);
  }
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/competitors') {
    return handleLlmMentionsCompetitorsGet(request);
  }
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/prompt-intelligence') {
    return handleLlmMentionsPromptIntelligenceGet(request);
  }
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/source-gap') {
    return handleLlmMentionsSourceGapGet(request);
  }

  // Sites
  if (method === 'GET' && url.pathname === '/v1/sites') {
    return handleSitesListGet(request);
  }
  const siteConfigMatch = url.pathname.match(/^\/v1\/sites\/([^/]+)\/config$/);
  if (method === 'GET' && siteConfigMatch) {
    return handleSiteConfigGet(request, siteConfigMatch[1]);
  }

  // Auth me
  if (method === 'GET' && url.pathname === '/v1/auth/me') {
    return handleAuthMeGet(request);
  }

  // Internal refresh
  if (method === 'POST' && url.pathname === '/internal/refresh/dashboard') {
    return handleDashboardRefreshPost(request);
  }
  if (method === 'POST' && url.pathname === '/internal/refresh/llm-mentions') {
    return handleLlmMentionsRefreshPost(request);
  }
  if (method === 'POST' && url.pathname === '/internal/refresh/process') {
    return handleRefreshProcessPost(request);
  }

  // Cron endpoint
  if ((method === 'GET' || method === 'POST') && url.pathname === '/internal/cron/refresh') {
    return handleRefreshProcessPost(request);
  }

  return { status: 404, body: { error: 'Not found' } };
}

// --- Handler implementations ---

async function handleDashboardOverviewGet(request) {
  const search = request.url.searchParams;
  const siteId = search.get('siteId') || null;
  const portalScope = normalizePortal(search.get('portal'));
  const rangeKey = normalizeRange(search.get('range'));
  const user = getUserContext(request);
  await assertSiteAccess({ siteId, portalScope, user });

  const identity = buildCacheIdentity({ portalScope, moduleKey: 'overview', siteId, rangeKey, params: { portalScope } });
  const row = await getCacheRow(identity);

  if (row && !isCacheStale(row)) {
    return { status: 200, body: dashboardOverviewResponseFromCache(row, { queued: false, reason: 'fresh_cache', jobId: null }) };
  }

  // Compute-on-miss: build fresh data when cache is empty or stale
  try {
    const payload = await buildDashboardOverview({ siteId, rangeKey, portalScope });
    // Write to cache in background (don't block response)
    upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule('overview') }).catch(() => {});
    return {
      status: 200,
      body: {
        data: payload,
        freshness: { overview: { status: 'computed', generatedAt: new Date().toISOString(), stale: false } },
        generatedAt: new Date().toISOString(),
        stale: false,
        refreshQueued: false,
      },
    };
  } catch (buildError) {
    console.error('buildDashboardOverview failed:', buildError?.message || buildError);
    // Fall back to stale cache if available
    if (row) {
      const refresh = await enqueueIfStale(row, identity, request);
      return { status: 200, body: dashboardOverviewResponseFromCache(row, refresh) };
    }
    return { status: 200, body: dashboardOverviewResponseFromCache(null, { queued: false, reason: 'build_failed', jobId: null }) };
  }
}

async function handleDashboardModuleGet(request, moduleKey) {
  const search = request.url.searchParams;
  const siteId = search.get('siteId') || null;
  const portalScope = normalizePortal(search.get('portal'));
  const rangeKey = normalizeRange(search.get('range'));
  const user = getUserContext(request);
  if (!DASHBOARD_MODULES.includes(moduleKey)) {
    return { status: 404, body: { error: `Unsupported module: ${moduleKey}` } };
  }
  await assertSiteAccess({ siteId, portalScope, user });

  const identity = buildCacheIdentity({ portalScope, moduleKey, siteId, rangeKey, params: { portalScope } });
  const row = await getCacheRow(identity);

  if (row && !isCacheStale(row)) {
    return { status: 200, body: moduleResponseFromCache(row, { queued: false, reason: 'fresh_cache', jobId: null }, moduleKey) };
  }

  // Compute-on-miss
  try {
    const payload = await buildModule(moduleKey, { siteId, rangeKey, portalScope });
    upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(moduleKey) }).catch(() => {});
    return {
      status: 200,
      body: {
        data: payload,
        freshness: { [moduleKey]: { status: 'computed', generatedAt: new Date().toISOString(), stale: false } },
        generatedAt: new Date().toISOString(),
        stale: false,
        refreshQueued: false,
      },
    };
  } catch (buildError) {
    console.error(`buildModule(${moduleKey}) failed:`, buildError?.message || buildError);
    if (row) {
      const refresh = await enqueueIfStale(row, identity, request);
      return { status: 200, body: moduleResponseFromCache(row, refresh, moduleKey) };
    }
    return { status: 200, body: moduleResponseFromCache(null, { queued: false, reason: 'build_failed', jobId: null }, moduleKey) };
  }
}

async function handleLlmMentionsOverviewGet(request) {
  const search = request.url.searchParams;
  const siteId = search.get('siteId');
  if (!siteId) return { status: 400, body: { error: 'siteId is required' } };
  const portalScope = normalizePortal(search.get('portal'));
  const user = getUserContext(request);
  await assertSiteAccess({ siteId, portalScope, user });

  const days = Number(search.get('days') || 7);
  const sources = (search.get('sources') || 'chat_gpt,google_ai_overviews').split(',').map((s) => s.trim()).filter(Boolean);
  const rangeKey = `${Number.isFinite(days) ? days : 7}d`;
  const identity = buildCacheIdentity({ portalScope, moduleKey: 'llm_mentions_overview', siteId, rangeKey, params: { days, sources } });
  const row = await getCacheRow(identity);

  if (row && !isCacheStale(row)) {
    return { status: 200, body: llmOverviewResponseFromCache(row, { queued: false, reason: 'fresh_cache', jobId: null }) };
  }

  try {
    const payload = await buildLlmMentionsOverview({ siteId, days, sources });
    upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule('llm_mentions_overview') }).catch(() => {});
    return {
      status: 200,
      body: {
        data: { sources: {}, combined: payload },
        freshness: { llm_mentions_overview: { status: 'computed', generatedAt: new Date().toISOString(), stale: false } },
        generatedAt: new Date().toISOString(),
        stale: false,
        refreshQueued: false,
      },
    };
  } catch (buildError) {
    console.error('buildLlmMentionsOverview failed:', buildError?.message || buildError);
    if (row) {
      const refresh = await enqueueIfStale(row, identity, request);
      return { status: 200, body: llmOverviewResponseFromCache(row, refresh) };
    }
    return { status: 200, body: llmOverviewResponseFromCache(null, { queued: false, reason: 'build_failed', jobId: null }) };
  }
}

async function handleLlmMentionsTrendsGet(request) {
  const search = request.url.searchParams;
  const siteId = search.get('siteId');
  if (!siteId) return { status: 400, body: { error: 'siteId is required' } };
  const source = search.get('source') || 'chat_gpt';
  const days = Number(search.get('days') || 7);
  const rollupType = search.get('rollupType') || 'summary';
  const data = await buildLlmMentionsTrends({ siteId, source, days, rollupType });
  return { status: 200, body: data };
}

async function handleLlmMentionsCompetitorsGet(request) {
  const search = request.url.searchParams;
  const siteId = search.get('siteId');
  if (!siteId) return { status: 400, body: { error: 'siteId is required' } };
  const source = search.get('source') || 'chat_gpt';
  const data = await buildLlmMentionsCompetitors({ siteId, source });
  return { status: 200, body: data };
}

async function handleLlmMentionsPromptIntelligenceGet(request) {
  const search = request.url.searchParams;
  const siteId = search.get('siteId');
  if (!siteId) return { status: 400, body: { error: 'siteId is required' } };
  const source = search.get('source') || 'chat_gpt';
  const data = await buildLlmMentionsPromptIntelligence({ siteId, source });
  return { status: 200, body: data };
}

async function handleLlmMentionsSourceGapGet(request) {
  const search = request.url.searchParams;
  const siteId = search.get('siteId');
  if (!siteId) return { status: 400, body: { error: 'siteId is required' } };
  const source = search.get('source') || 'chat_gpt';
  const data = await buildLlmMentionsSourceGap({ siteId, source });
  return { status: 200, body: data };
}

async function handleSitesListGet(_request) {
  const sites = await buildSitesList();
  return { status: 200, body: sites };
}

async function handleSiteConfigGet(_request, siteId) {
  const config = await buildSiteConfig(siteId);
  return { status: 200, body: config };
}

async function handleAuthMeGet(request) {
  const user = getUserContext(request);
  return { status: 200, body: { user } };
}

async function handleDashboardRefreshPost(request) {
  const body = await readJson(request);
  if (body.processQueued === true) {
    return handleRefreshProcessPost(request, body);
  }
  const siteId = body.siteId || null;
  const portalScope = normalizePortal(body.portalScope || body.portal);
  const rangeKey = normalizeRange(body.range);
  const modules = Array.isArray(body.modules) && body.modules.length > 0
    ? body.modules
    : ['telemetry', 'authority', 'executive_summary', 'experience', 'search_diagnostics', 'confusion', 'coverage'];
  const user = getUserContext(request);
  await assertSiteAccess({ siteId, portalScope, user });

  const results = [];
  for (const moduleKey of modules.filter((k) => DASHBOARD_MODULES.includes(k) && k !== 'overview')) {
    const identity = buildCacheIdentity({ portalScope, moduleKey, siteId, rangeKey, params: { portalScope } });
    const payload = await buildModule(moduleKey, { siteId, rangeKey, portalScope });
    await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(moduleKey) });
    results.push({ moduleKey, ok: true });
  }

  const overviewIdentity = buildCacheIdentity({ portalScope, moduleKey: 'overview', siteId, rangeKey, params: { portalScope } });
  const overview = await buildDashboardOverview({ siteId, rangeKey, portalScope });
  await upsertCacheRow(overviewIdentity, overview, { ttlSeconds: ttlForModule('overview') });
  results.push({ moduleKey: 'overview', ok: true });

  return { status: 200, body: { ok: true, siteId, portalScope, range: rangeKey, results } };
}

async function handleRefreshProcessPost(request, providedBody = null) {
  const body = providedBody || (await readJson(request));
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

  return { status: 200, body: { ok: true, claimed: jobs.length, results } };
}

async function handleLlmMentionsRefreshPost(request) {
  const body = await readJson(request);
  const siteId = body.siteId;
  if (!siteId) return { status: 400, body: { error: 'siteId is required' } };
  const portalScope = normalizePortal(body.portalScope || body.portal);
  const user = getUserContext(request);
  await assertSiteAccess({ siteId, portalScope, user });

  const sources = Array.isArray(body.sources) && body.sources.length > 0 ? body.sources : ['chat_gpt', 'google_ai_overviews'];
  const days = Number(body.days || 7);
  const payload = await buildLlmMentionsOverview({ siteId, days, sources });
  const identity = buildCacheIdentity({ portalScope, moduleKey: 'llm_mentions_overview', siteId, rangeKey: `${Number.isFinite(days) ? days : 7}d`, params: { days, sources } });
  await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule('llm_mentions_overview') });

  return { status: 200, body: { ok: true, siteId, sources } };
}
