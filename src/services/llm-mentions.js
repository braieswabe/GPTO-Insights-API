import { assertSiteAccess, getUserContext } from '../access.js';
import { buildCacheIdentity, getCacheRow, isCacheStale, serializeCacheRow, upsertCacheRow } from '../cache.js';
import { computedFreshness, normalizeSources, ok, parsePositiveInt, requireSiteId, responseEnvelope } from '../contracts.js';
import { enqueueRefreshJob } from '../jobs.js';
import { ttlForModule, normalizePortal } from '../types.js';
import {
  buildLegacyLlmMentionsResponse,
  buildLlmEndpointResponse,
  createTrackedPrompt,
  deleteTrackedPrompt,
  getTrackedPromptSiteId,
  listRawSnapshots,
  listTrackedPrompts,
  runPromptRefresh,
  runRawRequest,
  updateTrackedPrompt,
} from '../builders/llm-admin.js';
import {
  buildLlmMentionsCompetitors,
  buildLlmMentionsOverview,
  buildLlmMentionsPromptIntelligence,
  buildLlmMentionsSourceGap,
  buildLlmMentionsTrends,
} from '../builders/llm-mentions.js';

function llmOverviewEnvelope(row, refresh) {
  const serialized = serializeCacheRow(row);
  const freshness = serialized?.metadata || {
    status: 'missing',
    generatedAt: null,
    sourceWatermarkAt: null,
    expiresAt: null,
    stale: true,
    error: null,
  };
  const payload = serialized?.payload || null;
  const sourceRows = payload?.summary?.platformBreakdown || [];
  const sources = {};
  for (const item of sourceRows) {
    if (item?.source) sources[item.source] = item;
  }
  return responseEnvelope({
    key: 'llm_mentions_overview',
    data: { sources, combined: payload },
    freshness,
    stale: !row || isCacheStale(row),
    refresh,
    generatedAt: freshness.generatedAt,
  });
}

async function enqueueLlmOverviewRefresh(row, identity, user) {
  if (row && !isCacheStale(row)) return { queued: false, reason: 'fresh_cache', jobId: null };
  try {
    return await enqueueRefreshJob(identity, { requestedBy: user?.userId || null, priority: row ? 0 : 5 });
  } catch (error) {
    console.error('enqueue LLM overview refresh failed (non-fatal):', error?.message || error);
    return { queued: false, reason: 'enqueue_error', jobId: null };
  }
}

async function assertLlmSiteAccess(request, explicitSiteId = null) {
  const siteId = requireSiteId(explicitSiteId || request.url.searchParams);
  const portalScope = normalizePortal(request.url.searchParams.get('portal'));
  const user = getUserContext(request);
  await assertSiteAccess({ siteId, portalScope, user });
  return { siteId, portalScope, user };
}

async function timed(name, fn) {
  const startedAt = Date.now();
  try {
    return { name, ok: true, value: await fn(), durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      name,
      ok: false,
      value: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function requestWithSearchParams(request, searchParams) {
  const url = new URL(request.url.toString());
  url.search = searchParams.toString();
  return { ...request, url };
}

export async function readLlmMentionsOverview(request) {
  const search = request.url.searchParams;
  if (!search.get('siteId')) return { status: 400, body: { error: 'siteId is required' } };
  const { siteId, portalScope, user } = await assertLlmSiteAccess(request);
  const days = parsePositiveInt(search.get('days'), 7, { min: 1, max: 90 });
  const sources = normalizeSources(search.get('sources'));
  const rangeKey = `${days}d`;
  const identity = buildCacheIdentity({ portalScope, moduleKey: 'llm_mentions_overview', siteId, rangeKey, params: { days, sources } });
  const row = await getCacheRow(identity);
  if (row) {
    const refresh = isCacheStale(row) ? await enqueueLlmOverviewRefresh(row, identity, user) : null;
    return ok(llmOverviewEnvelope(row, refresh));
  }

  try {
    const payload = await buildLlmMentionsOverview({ siteId, days, sources });
    await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule('llm_mentions_overview') });
    return ok(responseEnvelope({
      key: 'llm_mentions_overview',
      data: { sources: {}, combined: payload },
      freshness: computedFreshness(),
    }));
  } catch (error) {
    console.error('buildLlmMentionsOverview failed:', error?.message || error);
    if (row) return ok(llmOverviewEnvelope(row, { queued: false, reason: 'build_failed', jobId: null }));
    return ok(llmOverviewEnvelope(null, { queued: false, reason: 'build_failed', jobId: null }));
  }
}

export async function readLlmMentionsBundle(request) {
  const search = request.url.searchParams;
  if (!search.get('siteId')) return { status: 400, body: { error: 'siteId is required' } };
  const { siteId } = await assertLlmSiteAccess(request);
  const days = parsePositiveInt(search.get('days'), search.get('range') === '30d' ? 30 : 7, { min: 1, max: 90 });
  const source = search.get('source') || 'chat_gpt';
  const bundleSearch = new URLSearchParams(search);
  if (!bundleSearch.get('days')) bundleSearch.set('days', String(days));
  const bundleRequest = requestWithSearchParams(request, bundleSearch);

  const sections = await Promise.all([
    timed('overview', () => readLlmMentionsOverview(bundleRequest)),
    timed('legacy', () => buildLegacyLlmMentionsResponse(bundleSearch)),
    timed('trends', () => buildLlmMentionsTrends({ siteId, source, days, rollupType: search.get('rollupType') || 'summary' })),
    timed('competitors', () => buildLlmMentionsCompetitors({ siteId, source })),
    timed('promptIntelligence', () => buildLlmMentionsPromptIntelligence({ siteId, source })),
    timed('sourceGap', () => buildLlmMentionsSourceGap({ siteId, source })),
    timed('aggregated', () => buildLlmEndpointResponse('aggregated', bundleSearch)),
    timed('topPages', () => buildLlmEndpointResponse('top-pages', bundleSearch)),
    timed('topDomains', () => buildLlmEndpointResponse('top-domains', bundleSearch)),
    timed('search', () => buildLlmEndpointResponse('search', bundleSearch)),
  ]);

  const byName = Object.fromEntries(sections.map((section) => [section.name, section]));
  const overview = byName.overview.value?.body || {};
  return ok({
    data: {
      llmMentions: {
        overview: overview.data || null,
        summary: byName.legacy.value || null,
        trends: byName.trends.value || null,
        competitors: byName.competitors.value || null,
        promptIntelligence: byName.promptIntelligence.value || null,
        sourceGap: byName.sourceGap.value || null,
        endpoints: {
          aggregated: byName.aggregated.value || null,
          topPages: byName.topPages.value || null,
          topDomains: byName.topDomains.value || null,
          search: byName.search.value || null,
        },
      },
      timings: sections.map(({ name, ok: sectionOk, durationMs, error }) => ({ name, ok: sectionOk, durationMs, error })),
    },
    freshness: {
      llm_mentions_bundle: { ...computedFreshness(), stale: Boolean(overview.stale) },
      ...(overview.freshness || {}),
    },
    generatedAt: new Date().toISOString(),
    stale: Boolean(overview.stale),
    refreshQueued: Boolean(overview.refreshQueued),
    refreshQueueReason: overview.refreshQueueReason || null,
    jobId: overview.jobId || null,
  });
}

export async function readLegacyLlmMentions(request) {
  if (!request.url.searchParams.get('siteId')) return { status: 400, body: { error: 'siteId is required' } };
  await assertLlmSiteAccess(request);
  return ok(await buildLegacyLlmMentionsResponse(request.url.searchParams));
}

export async function readLlmEndpoint(request, endpoint) {
  if (!request.url.searchParams.get('siteId')) return { status: 400, body: { error: 'siteId is required' } };
  await assertLlmSiteAccess(request);
  return ok(await buildLlmEndpointResponse(endpoint, request.url.searchParams));
}

export async function readLlmTrends(request) {
  const search = request.url.searchParams;
  if (!search.get('siteId')) return { status: 400, body: { error: 'siteId is required' } };
  const { siteId } = await assertLlmSiteAccess(request);
  return ok(await buildLlmMentionsTrends({
    siteId,
    source: search.get('source') || 'chat_gpt',
    days: parsePositiveInt(search.get('days'), 7, { min: 1, max: 90 }),
    rollupType: search.get('rollupType') || 'summary',
  }));
}

export async function readLlmCompetitors(request) {
  const search = request.url.searchParams;
  if (!search.get('siteId')) return { status: 400, body: { error: 'siteId is required' } };
  const { siteId } = await assertLlmSiteAccess(request);
  return ok(await buildLlmMentionsCompetitors({ siteId, source: search.get('source') || 'chat_gpt' }));
}

export async function readPromptIntelligence(request) {
  const search = request.url.searchParams;
  if (!search.get('siteId')) return { status: 400, body: { error: 'siteId is required' } };
  const { siteId } = await assertLlmSiteAccess(request);
  return ok(await buildLlmMentionsPromptIntelligence({ siteId, source: search.get('source') || 'chat_gpt' }));
}

export async function readSourceGap(request) {
  const search = request.url.searchParams;
  if (!search.get('siteId')) return { status: 400, body: { error: 'siteId is required' } };
  const { siteId } = await assertLlmSiteAccess(request);
  return ok(await buildLlmMentionsSourceGap({ siteId, source: search.get('source') || 'chat_gpt' }));
}

export async function readRawSnapshots(request) {
  if (request.url.searchParams.get('siteId')) await assertLlmSiteAccess(request);
  return ok(await listRawSnapshots(request.url.searchParams));
}

export async function writeRawRequest(request, body) {
  if (body.siteId) await assertLlmSiteAccess(request, body.siteId);
  return ok(await runRawRequest(body, request.url.searchParams));
}

export async function refreshPrompts(request) {
  await assertLlmSiteAccess(request);
  return ok(await runPromptRefresh(request.url.searchParams));
}

export async function readTrackedPrompts(request) {
  await assertLlmSiteAccess(request);
  return ok(await listTrackedPrompts(request.url.searchParams));
}

export async function writeTrackedPrompt(request, body) {
  await assertLlmSiteAccess(request, body.siteId);
  return ok(await createTrackedPrompt(body));
}

export async function patchTrackedPrompt(request, id, body) {
  await assertLlmSiteAccess(request, await getTrackedPromptSiteId(id));
  return ok(await updateTrackedPrompt(id, body));
}

export async function removeTrackedPrompt(request, id) {
  await assertLlmSiteAccess(request, await getTrackedPromptSiteId(id));
  return ok(await deleteTrackedPrompt(id));
}

export async function refreshLlmMentions(request, body) {
  const siteId = body.siteId;
  if (!siteId) return { status: 400, body: { error: 'siteId is required' } };
  const portalScope = normalizePortal(body.portalScope || body.portal);
  const user = getUserContext(request);
  await assertSiteAccess({ siteId, portalScope, user });

  const sources = normalizeSources(body.sources);
  const days = parsePositiveInt(body.days, 7, { min: 1, max: 90 });
  const payload = await buildLlmMentionsOverview({ siteId, days, sources });
  const identity = buildCacheIdentity({ portalScope, moduleKey: 'llm_mentions_overview', siteId, rangeKey: `${days}d`, params: { days, sources } });
  await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule('llm_mentions_overview') });
  return ok({ ok: true, siteId, sources });
}
