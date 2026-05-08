import { assertSiteAccess, getUserContext } from '../access.js';
import { buildCacheIdentity, getCacheRow, isCacheStale, serializeCacheRow, upsertCacheRow } from '../cache.js';
import { db } from '../db.js';
import { claimRefreshJobs, completeRefreshJob, enqueueRefreshJob } from '../jobs.js';
import { DEFAULT_LLM_MENTION_SOURCES, computedFreshness, missingFreshness, ok, responseEnvelope } from '../contracts.js';
import { buildDashboardOverview, buildModule, buildLlmMentionsOverview } from '../builders/index.js';
import { buildDashboardStats, buildGoldDashboard } from '../builders/gold.js';
import { buildCsuite, buildMonthlyInsights } from '../builders/csuite.js';
import { buildSiteConfig } from '../builders/sites.js';
import { readLegacyLlmMentions, readLlmCompetitors, readSourceGap } from './llm-mentions.js';
import { DASHBOARD_MODULES, EMPTY_SITE_UUID, normalizeDashboardModuleKey, normalizePortal, rangeToDays, ttlForModule } from '../types.js';
import {
  boundsDaySpan,
  boundsFromInput,
  buildDashboardCacheParams,
  parseDashboardRangeFromBody,
  parseDashboardRangeFromSearchParams,
  parseSeriesGranularity,
  resolveDashboardTimeBounds,
} from '../dashboard-range.js';
import { runTelemetryRollupCronWindow } from './telemetry-daily-rollup.js';
import { materializeSignalsOnGptoSuite } from './gpto-signal-materialize.js';
import { composeReportPayload } from '../pdf/compose.js';
import { renderDashboardReport } from '../pdf/render.js';

const DASHBOARD_PREWARM_RANGES = ['7d', '30d'];
const DASHBOARD_PREWARM_PORTALS = ['admin', 'employee'];
const ALLOWED_EXPORT_MODES = new Set(['client', 'technical']);
const TECHNICAL_EXPORT_ROLES = new Set(['admin', 'employee', 'super_admin', 'owner']);

let readDashboardReportBundleForExport = null;

export function setDashboardReportBundleReaderForTests(reader) {
  readDashboardReportBundleForExport = reader;
}

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

function payloadFreshness(savedRow) {
  return serializeCacheRow(savedRow)?.metadata || computedFreshness();
}

function dashboardPayloadSatisfiesContract(payload, moduleKey) {
  if (!payload) return false;
  if (moduleKey === 'overview') return Boolean(payload.display);
  if (moduleKey === 'export_data') return Boolean(payload.display);
  if (moduleKey === 'gold') {
    const axes = payload.optimisationAxes || {};
    const axisValues = Object.values(axes);
    const hasPlainLanguage = axisValues.length > 0 && axisValues.every((axis) => axis && typeof axis.plainLanguage === 'string');
    const hasVisitorScore = payload.customerInsights?.visitorBehavior?.score !== undefined;
    return hasPlainLanguage && hasVisitorScore;
  }
  return true;
}

export function shouldServeCachedDashboardRow(row, moduleKey = null) {
  if (!row) return false;
  if (!moduleKey) return true;
  return dashboardPayloadSatisfiesContract(row.payload, moduleKey);
}

export function shouldQueueDashboardRefresh(row) {
  return Boolean(row && isCacheStale(row));
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

function requestContext(request) {
  return request || { headers: {} };
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

function bundleResponse({ key, data, freshness = {}, timings = [], stale = false, refreshQueued = false, jobId = null }) {
  const generatedAt = new Date().toISOString();
  return ok({
    data: { ...data, timings },
    freshness: {
      [key]: {
        ...computedFreshness(),
        stale,
      },
      ...freshness,
    },
    generatedAt,
    stale,
    refreshQueued,
    refreshQueueReason: refreshQueued ? 'section_refresh_queued' : null,
    jobId,
  });
}

async function readCachedEnvelope({ request, identity, moduleKey, fallback, compute }) {
  const row = await getCacheRow(identity);
  if (shouldServeCachedDashboardRow(row, moduleKey)) {
    const refresh = shouldQueueDashboardRefresh(row) ? await enqueueIfStale(row, identity, requestContext(request)) : null;
    return ok(cacheEnvelope(row, refresh, moduleKey, fallback));
  }

  try {
    const payload = await compute();
    const savedRow = await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(moduleKey) });
    const freshness = payloadFreshness(savedRow);
    return ok(responseEnvelope({ key: moduleKey, data: payload, freshness, generatedAt: freshness.generatedAt }));
  } catch (error) {
    console.error(`compute ${moduleKey} failed:`, error?.message || error);
    return ok(cacheEnvelope(null, { queued: false, reason: 'build_failed', jobId: null }, moduleKey, fallback));
  }
}

async function readCachedDirectPayload({ request, identity, moduleKey, compute }) {
  const row = await getCacheRow(identity);
  if (shouldServeCachedDashboardRow(row, moduleKey)) {
    if (shouldQueueDashboardRefresh(row)) await enqueueIfStale(row, identity, requestContext(request));
    return serializeCacheRow(row)?.payload ?? null;
  }

  const payload = await compute();
  await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(moduleKey) });
  return payload;
}

async function buildExportData(context) {
  const { start, end } = boundsFromInput(context);
  const spanDays = boundsDaySpan({ start, end });
  const [telemetry, confusion, authority, schema, coverage, index, executive, llmMentions, aiReadability] = await Promise.all([
    buildModule('telemetry', context),
    buildModule('confusion', context),
    buildModule('authority', context),
    buildModule('schema', context),
    buildModule('coverage', context),
    buildModule('index', context),
    buildModule('executive_summary', context),
    context.siteId
      ? buildLlmMentionsOverview({
          siteId: context.siteId,
          days: spanDays,
          windowStart: start,
          windowEnd: end,
          sources: DEFAULT_LLM_MENTION_SOURCES,
        }).catch(() => null)
      : Promise.resolve(null),
    buildModule('ai_readability', context).catch(() => null),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    range: context.rangeKey,
    telemetry,
    confusion,
    authority,
    schema,
    coverage,
    index,
    executive,
    executiveSummary: executive,
    llmMentions,
    aiReadability,
    display: {
      telemetry: telemetry
        ? {
            pageViews: telemetry?.totals?.pageViews ?? 0,
            visits: telemetry?.totals?.visits ?? 0,
            trendPct: telemetry?.trendPct || null,
            trendPctLabel: telemetry?.trendPctLabel || null,
          }
        : null,
      authority: authority ? { score: authority.authorityScore, band: authority.band, severity: authority.severity } : null,
      schema: schema
        ? {
            completenessScore: schema.completenessScore,
            qualityScore: schema.qualityScore,
            band: schema.band,
            severity: schema.severity,
          }
        : null,
      coverage: coverage
        ? {
            priorityFixes: coverage?.totals?.priorityFixes ?? 0,
            riskBand: coverage.riskBand ?? null,
            riskLabel: executive?.pulseBlends?.coverageRisk?.label ?? null,
          }
        : null,
      confusion: confusion
        ? {
            total:
              Number(confusion?.totals?.repeatedSearches || 0)
              + Number(confusion?.totals?.deadEnds || 0)
              + Number(confusion?.totals?.dropOffs || 0)
              + Number(confusion?.totals?.intentMismatches || 0),
            confidence: confusion?.confidence?.level ?? 'Unknown',
          }
        : null,
      aiVisibility: llmMentions?.aiVisibility
        ? {
            composite: llmMentions.aiVisibility.composite,
            band: llmMentions.aiVisibility.band,
            mentions: llmMentions.summary?.metrics?.mentions ?? null,
            aiSearchVolume: llmMentions.summary?.metrics?.aiSearchVolume ?? null,
            impressions: llmMentions.summary?.metrics?.impressions ?? null,
          }
        : null,
    },
  };
}

async function buildDashboardCachePayload(moduleKey, context) {
  const normalized = normalizeDashboardModuleKey(moduleKey);
  if (normalized === 'overview') return buildDashboardOverview(context);
  if (normalized === 'gold') return buildGoldDashboard(context);
  if (normalized === 'stats') return buildDashboardStats(context);
  if (normalized === 'export_data') return buildExportData(context);
  if (normalized === 'csuite') return buildCsuite(context);
  if (normalized === 'monthly_insights') return buildMonthlyInsights(context);
  if (normalized === 'llm_mentions_overview') {
    const { start, end } = boundsFromInput(context);
    const spanDays = boundsDaySpan({ start, end });
    const days = Number(context.params?.days || spanDays);
    const sources = Array.isArray(context.params?.sources) ? context.params.sources : DEFAULT_LLM_MENTION_SOURCES;
    return buildLlmMentionsOverview({
      siteId: context.siteId,
      days,
      windowStart: start,
      windowEnd: end,
      sources,
    });
  }
  return buildModule(normalized, context);
}

export function parseDashboardContext(request, { customerDefault = false } = {}) {
  const search = request.url.searchParams;
  const { rangeKey: parsedRange, customStart, customEnd } = parseDashboardRangeFromSearchParams(search);
  const bounds = resolveDashboardTimeBounds(parsedRange, customStart, customEnd);
  const seriesGranularity = parseSeriesGranularity(search.get('granularity'));
  const portalScope = normalizePortal(search.get('portal') || (customerDefault ? 'customer' : null));
  const params = buildDashboardCacheParams(portalScope, bounds, seriesGranularity);
  return {
    siteId: search.get('siteId') || null,
    portalScope,
    rangeKey: bounds.rangeKey,
    windowStart: bounds.start,
    windowEnd: bounds.end,
    seriesGranularity,
    params,
    user: getUserContext(request),
  };
}

export async function readDashboardOverview(request) {
  const context = parseDashboardContext(request);
  await assertSiteAccess(context);

  const identity = cacheIdentity({
    ...context,
    moduleKey: 'overview',
    params: context.params,
  });
  return readCachedEnvelope({
    request,
    identity,
    moduleKey: 'overview',
    fallback: emptyDashboardOverview(),
    compute: () => buildDashboardOverview(context),
  });
}

export async function readDashboardModule(request, rawModuleKey) {
  const moduleKey = normalizeDashboardModuleKey(rawModuleKey);
  const context = parseDashboardContext(request);
  if (!DASHBOARD_MODULES.includes(moduleKey)) {
    return { status: 404, body: { error: `Unsupported module: ${rawModuleKey}` } };
  }
  await assertSiteAccess(context);

  const identity = cacheIdentity({
    ...context,
    moduleKey,
    params: context.params,
  });
  return readCachedEnvelope({
    request,
    identity,
    moduleKey,
    compute: () => buildModule(moduleKey, context),
  });
}

export async function readDashboardGold(request) {
  const context = parseDashboardContext(request, { customerDefault: true });
  if (!context.siteId) return { status: 400, body: { error: 'siteId is required' } };
  await assertSiteAccess(context);
  const identity = cacheIdentity({ ...context, moduleKey: 'gold', params: context.params });
  return ok(await readCachedDirectPayload({
    request,
    identity,
    moduleKey: 'gold',
    compute: () => buildGoldDashboard(context),
  }));
}

export async function readDashboardStats(request) {
  const context = parseDashboardContext(request);
  await assertSiteAccess(context);
  const identity = cacheIdentity({ ...context, moduleKey: 'stats', params: context.params });
  return ok(await readCachedDirectPayload({
    request,
    identity,
    moduleKey: 'stats',
    compute: () => buildDashboardStats(context),
  }));
}

export async function readDashboardCsuite(request) {
  const context = parseDashboardContext(request);
  if (!context.siteId) return { status: 400, body: { error: 'siteId is required' } };
  await assertSiteAccess(context);
  const identity = cacheIdentity({ ...context, moduleKey: 'csuite', params: context.params });
  return ok(await readCachedDirectPayload({
    request,
    identity,
    moduleKey: 'csuite',
    compute: () => buildCsuite(context),
  }));
}

export async function readDashboardMonthlyInsights(request) {
  const context = parseDashboardContext(request);
  if (!context.siteId) return { status: 400, body: { error: 'siteId is required' } };
  await assertSiteAccess(context);
  const identity = cacheIdentity({ ...context, moduleKey: 'monthly_insights', params: context.params });
  return ok(await readCachedDirectPayload({
    request,
    identity,
    moduleKey: 'monthly_insights',
    compute: () => buildMonthlyInsights(context),
  }));
}

export async function readDashboardExportData(request) {
  const context = parseDashboardContext(request);
  await assertSiteAccess(context);
  const identity = cacheIdentity({ ...context, moduleKey: 'export_data', params: context.params });
  return ok(await readCachedDirectPayload({
    request,
    identity,
    moduleKey: 'export_data',
    compute: () => buildExportData(context),
  }));
}

export async function readDashboardBundle(request) {
  const context = parseDashboardContext(request);
  await assertSiteAccess(context);

  const [overviewResult, statsResult] = await Promise.all([
    timed('overview', () => readDashboardOverview(request)),
    timed('stats', () => readDashboardStats(request)),
  ]);

  if (overviewResult.value?.status && overviewResult.value.status !== 200) return overviewResult.value;

  const overviewBody = overviewResult.value?.body || {};
  const statsBody = statsResult.value?.body || null;
  return bundleResponse({
    key: 'dashboard_bundle',
    data: {
      dashboard: overviewBody.data || emptyDashboardOverview(),
      stats: statsBody,
      llmMentions: overviewBody.data?.llmMentions || null,
    },
    freshness: overviewBody.freshness || {},
    timings: [overviewResult, statsResult].map(({ name, ok: sectionOk, durationMs, error }) => ({ name, ok: sectionOk, durationMs, error })),
    stale: Boolean(overviewBody.stale),
    refreshQueued: Boolean(overviewBody.refreshQueued),
    jobId: overviewBody.jobId || null,
  });
}

export async function readDashboardReportBundle(request) {
  const context = parseDashboardContext(request);
  await assertSiteAccess(context);
  const reportSearch = new URLSearchParams(request.url.searchParams);
  const { start, end } = boundsFromInput(context);
  if (!reportSearch.get('days')) reportSearch.set('days', String(boundsDaySpan({ start, end })));
  const reportRequest = requestWithSearchParams(request, reportSearch);

  const tasks = [
    timed('exportData', () => readDashboardExportData(request)),
    context.siteId ? timed('siteDetail', () => buildSiteConfig(context.siteId)) : Promise.resolve({ name: 'siteDetail', ok: true, value: null, durationMs: 0 }),
    context.siteId ? timed('llmMentions', () => readLegacyLlmMentions(reportRequest)) : Promise.resolve({ name: 'llmMentions', ok: true, value: null, durationMs: 0 }),
    context.siteId ? timed('llmSourceGap', () => readSourceGap(reportRequest)) : Promise.resolve({ name: 'llmSourceGap', ok: true, value: null, durationMs: 0 }),
    context.siteId ? timed('llmCompetitors', () => readLlmCompetitors(reportRequest)) : Promise.resolve({ name: 'llmCompetitors', ok: true, value: null, durationMs: 0 }),
  ];
  const [exportData, siteDetail, llmMentions, llmSourceGap, llmCompetitors] = await Promise.all(tasks);
  if (exportData.value?.status && exportData.value.status !== 200) return exportData.value;

  const report = exportData.value?.body || {};
  return bundleResponse({
    key: 'dashboard_report_bundle',
    data: {
      report: {
        ...report,
        siteDetail: siteDetail.value || null,
        llmMentions: llmMentions.value?.body || report.llmMentions || null,
        llmMentionsSourceGap: llmSourceGap.value?.body || null,
        llmMentionsCompetitors: llmCompetitors.value?.body || null,
      },
    },
    timings: [exportData, siteDetail, llmMentions, llmSourceGap, llmCompetitors].map(({ name, ok: sectionOk, durationMs, error }) => ({ name, ok: sectionOk, durationMs, error })),
    stale: false,
  });
}

function parseExportMode(value, role) {
  const requested = ALLOWED_EXPORT_MODES.has(String(value || '').toLowerCase())
    ? String(value).toLowerCase()
    : 'client';
  if (requested !== 'technical') return requested;
  return TECHNICAL_EXPORT_ROLES.has(String(role || '').toLowerCase()) ? 'technical' : 'client';
}

function safeBrandSlug(value) {
  if (!value) return 'gpto';
  const cleaned = String(value).replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
  return cleaned || 'gpto';
}

function buildFileName(brand, mode, rangeKey, ext) {
  const dateStr = new Date().toISOString().slice(0, 10);
  return `gpto-${safeBrandSlug(brand)}-${mode}-${rangeKey}-${dateStr}.${ext}`;
}

export async function readDashboardExport(request) {
  const context = parseDashboardContext(request);
  const format = String(request.url.searchParams.get('format') || 'json').toLowerCase();
  const preparedFor = request.url.searchParams.get('preparedFor') || null;
  const mode = parseExportMode(request.url.searchParams.get('mode'), context.user?.role);
  const { start, end } = boundsFromInput(context);
  const reader = readDashboardReportBundleForExport || readDashboardReportBundle;
  const bundleResult = await reader(request);
  if (bundleResult?.status && bundleResult.status !== 200) return bundleResult;

  const reportBundle = bundleResult?.body?.data?.report || {};
  const payload = composeReportPayload({
    bundle: reportBundle,
    rangeKey: context.rangeKey,
    start,
    end,
    siteId: context.siteId,
    mode,
    preparedFor,
  });

  if (format === 'pdf') {
    const buffer = await renderDashboardReport(payload);
    const fileName = buildFileName(payload.site?.brand || payload.site?.domain, mode, context.rangeKey, 'pdf');
    return {
      status: 200,
      binary: true,
      body: buffer,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${fileName}"`,
        'cache-control': 'private, max-age=0, no-store',
      },
    };
  }

  const fileName = buildFileName(payload.site?.brand || payload.site?.domain, mode, context.rangeKey, 'json');
  return {
    status: 200,
    body: payload,
    headers: {
      'content-disposition': `attachment; filename="${fileName}"`,
    },
  };
}

async function listActiveDashboardSites() {
  const sql = db();
  return sql`
    SELECT id
    FROM sites
    WHERE status = 'active'
    ORDER BY domain ASC
  `;
}

function targetIdentity(target) {
  return cacheIdentity({
    portalScope: target.portalScope,
    moduleKey: target.moduleKey,
    siteId: target.siteId,
    rangeKey: target.rangeKey,
    params: target.params || { portalScope: target.portalScope },
  });
}

export function buildDashboardPrewarmTargets(sites, options = {}) {
  const ranges = options.ranges || DASHBOARD_PREWARM_RANGES;
  const portals = options.portalScopes || DASHBOARD_PREWARM_PORTALS;
  const siteIds = (sites || []).map((site) => (typeof site === 'string' ? site : site.id)).filter(Boolean);
  const targets = [];

  for (const rangeKey of ranges) {
    for (const portalScope of portals) {
      targets.push({ moduleKey: 'overview', siteId: null, rangeKey, portalScope, params: { portalScope } });
      targets.push({ moduleKey: 'stats', siteId: null, rangeKey, portalScope, params: { portalScope } });
    }

    for (const siteId of siteIds) {
      for (const portalScope of portals) {
        targets.push({ moduleKey: 'overview', siteId, rangeKey, portalScope, params: { portalScope } });
        targets.push({ moduleKey: 'stats', siteId, rangeKey, portalScope, params: { portalScope } });
      }

      targets.push({ moduleKey: 'gold', siteId, rangeKey, portalScope: 'customer', params: { portalScope: 'customer' } });
      targets.push({ moduleKey: 'csuite', siteId, rangeKey, portalScope: 'admin', params: { portalScope: 'admin' } });
      targets.push({ moduleKey: 'monthly_insights', siteId, rangeKey, portalScope: 'admin', params: { portalScope: 'admin' } });
      targets.push({
        moduleKey: 'llm_mentions_overview',
        siteId,
        rangeKey,
        portalScope: 'employee',
        params: { days: rangeToDays(rangeKey), sources: DEFAULT_LLM_MENTION_SOURCES },
      });
    }
  }

  return targets;
}

export async function prewarmDashboard(body = {}) {
  const limit = Math.max(1, Math.min(Number(body.limit || process.env.DASHBOARD_PREWARM_LIMIT || 20), 100));
  const force = body.force === true;
  const sites = await listActiveDashboardSites();
  const targets = buildDashboardPrewarmTargets(sites);
  const results = [];
  let processed = 0;

  for (const target of targets) {
    const identity = targetIdentity(target);
    const existing = await getCacheRow(identity);
    if (existing && !force && !isCacheStale(existing)) {
      results.push({ moduleKey: target.moduleKey, siteId: target.siteId, range: target.rangeKey, portalScope: target.portalScope, status: 'skipped_fresh' });
      continue;
    }
    if (processed >= limit) {
      results.push({ moduleKey: target.moduleKey, siteId: target.siteId, range: target.rangeKey, portalScope: target.portalScope, status: 'deferred' });
      continue;
    }

    try {
      const payload = await buildDashboardCachePayload(target.moduleKey, target);
      await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(target.moduleKey) });
      processed += 1;
      results.push({ moduleKey: target.moduleKey, siteId: target.siteId, range: target.rangeKey, portalScope: target.portalScope, status: 'ready' });
    } catch (error) {
      processed += 1;
      results.push({
        moduleKey: target.moduleKey,
        siteId: target.siteId,
        range: target.rangeKey,
        portalScope: target.portalScope,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return ok({ ok: true, totalTargets: targets.length, processed, results });
}

export async function refreshDashboard(request, body) {
  if (body.processQueued === true) return processRefreshJobs(body);

  const siteId = body.siteId || null;
  const portalScope = normalizePortal(body.portalScope || body.portal);
  const { rangeKey: parsedRange, customStart, customEnd } = parseDashboardRangeFromBody(body || {});
  const bounds = resolveDashboardTimeBounds(parsedRange, customStart, customEnd);
  const seriesGranularity = parseSeriesGranularity(body.granularity || body.seriesGranularity);
  const params = buildDashboardCacheParams(portalScope, bounds, seriesGranularity);
  const user = getUserContext(request);
  await assertSiteAccess({ siteId, portalScope, user });

  const buildCtx = {
    siteId,
    portalScope,
    rangeKey: bounds.rangeKey,
    windowStart: bounds.start,
    windowEnd: bounds.end,
    seriesGranularity,
    params,
    user,
  };

  const modules = Array.isArray(body.modules) && body.modules.length > 0
    ? body.modules.map(normalizeDashboardModuleKey)
    : ['telemetry', 'authority', 'executive_summary', 'experience', 'search_diagnostics', 'confusion', 'coverage'];

  const results = [];
  for (const moduleKey of modules.filter((key) => DASHBOARD_MODULES.includes(key) && key !== 'overview')) {
    const identity = cacheIdentity({ portalScope, moduleKey, siteId, rangeKey: bounds.rangeKey, params });
    const payload = await buildModule(moduleKey, buildCtx);
    await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(moduleKey) });
    results.push({ moduleKey, ok: true });
  }

  const overviewIdentity = cacheIdentity({ portalScope, moduleKey: 'overview', siteId, rangeKey: bounds.rangeKey, params });
  const overview = await buildDashboardOverview(buildCtx);
  await upsertCacheRow(overviewIdentity, overview, { ttlSeconds: ttlForModule('overview') });
  results.push({ moduleKey: 'overview', ok: true });

  return ok({ ok: true, siteId, portalScope, range: bounds.rangeKey, results });
}

export async function processRefreshJobs(body = {}) {
  const limit = Math.max(1, Math.min(Number(body.limit || 5), 10));
  const jobs = await claimRefreshJobs(limit);
  const results = [];

  for (const job of jobs) {
    try {
      const moduleKey = normalizeDashboardModuleKey(job.module_key);
      const siteId = job.site_id === EMPTY_SITE_UUID ? null : job.site_id;
      const identity = {
        portalScope: job.portal_scope,
        moduleKey,
        siteId,
        rangeKey: job.range_key,
        params: job.params || {},
        paramsHash: job.params_hash,
        modelVersion: job.model_version,
      };
      const jobParams = job.params || {};
      const bounds = resolveDashboardTimeBounds(job.range_key, jobParams.start || null, jobParams.end || null);
      const seriesGranularity = parseSeriesGranularity(jobParams.seriesGranularity);
      const payload = await buildDashboardCachePayload(moduleKey, {
        siteId,
        rangeKey: bounds.rangeKey,
        portalScope: job.portal_scope,
        windowStart: bounds.start,
        windowEnd: bounds.end,
        seriesGranularity,
        params: jobParams,
      });

      await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(moduleKey) });
      await completeRefreshJob(job.id, { ok: true });
      results.push({ jobId: job.id, moduleKey: job.module_key, ok: true });
    } catch (error) {
      await completeRefreshJob(job.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
      results.push({ jobId: job.id, moduleKey: job.module_key, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return ok({ ok: true, claimed: jobs.length, results });
}

export async function runDashboardCronRefresh(body = {}) {
  let telemetryRollup = null;
  if (process.env.TELEMETRY_ROLLUP_WITH_DASHBOARD_CRON === '1') {
    try {
      const trDays =
        body.telemetryRollupDaysBack != null
          ? Number(body.telemetryRollupDaysBack)
          : Number(process.env.TELEMETRY_ROLLUP_CRON_DAYS_BACK || 2);
      const trSites =
        body.telemetryRollupMaxSites != null
          ? Number(body.telemetryRollupMaxSites)
          : Number(process.env.TELEMETRY_ROLLUP_CRON_MAX_SITES || 40);
      const trRuns =
        body.telemetryRollupMaxRuns != null
          ? Number(body.telemetryRollupMaxRuns)
          : Number(process.env.TELEMETRY_ROLLUP_CRON_MAX_RUNS || 120);
      telemetryRollup = await runTelemetryRollupCronWindow({
        daysBack: trDays,
        maxSites: trSites,
        maxRuns: trRuns,
      });
    } catch (error) {
      console.error('runDashboardCronRefresh telemetry rollup failed:', error?.message || error);
      telemetryRollup = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  let suiteMaterialize = null;
  try {
    suiteMaterialize = await materializeSignalsOnGptoSuite(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('runDashboardCronRefresh GPTO signal materialize failed:', message);
    return {
      status: 502,
      body: {
        ok: false,
        error: message,
        telemetryRollup,
        suiteMaterialize: null,
      },
    };
  }

  const [prewarm, queuedJobs] = await Promise.all([
    prewarmDashboard({ limit: body.prewarmLimit || body.limit || process.env.DASHBOARD_PREWARM_LIMIT || 20, force: body.forcePrewarm === true }),
    processRefreshJobs({ limit: body.jobLimit || 5 }),
  ]);
  return ok({
    ok: true,
    telemetryRollup,
    suiteMaterialize,
    prewarm: prewarm.body,
    queuedJobs: queuedJobs.body,
  });
}
