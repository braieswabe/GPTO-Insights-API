import { getUserContext, requireInternalAuth } from './access.js';
import { readJson } from './http.js';
import { buildSiteConfig, buildSitesList } from './builders/sites.js';
import {
  processRefreshJobs,
  prewarmDashboard,
  readDashboardBundle,
  readDashboardExport,
  readDashboardExportData,
  readDashboardGold,
  readDashboardModule,
  readDashboardOverview,
  readDashboardReportBundle,
  readDashboardStats,
  refreshDashboard,
  runDashboardCronRefresh,
} from './services/dashboard.js';
import {
  getTelemetryDailyRollupProgress,
  postTelemetryDailyRollup,
} from './services/telemetry-daily-rollup.js';
import {
  patchTrackedPrompt,
  readLegacyLlmMentions,
  readLlmCompetitors,
  readLlmEndpoint,
  readLlmMentionsBundle,
  readLlmMentionsOverview,
  readLlmTrends,
  readPromptIntelligence,
  readRawSnapshots,
  readSourceGap,
  readTrackedPrompts,
  refreshLlmMentions,
  refreshPrompts,
  removeTrackedPrompt,
  writeRawRequest,
  writeTrackedPrompt,
} from './services/llm-mentions.js';

function requireAuthOrThrow(request) {
  const auth = requireInternalAuth(request);
  if (!auth.ok) {
    const error = new Error(auth.error);
    error.statusCode = auth.status;
    throw error;
  }
}

export async function route(request) {
  const { method, url } = request;

  if ((method === 'GET' || method === 'HEAD') && url.pathname === '/') {
    return { status: 200, body: { ok: true, service: 'gpto-insights-gateway', health: '/internal/health' } };
  }
  if ((method === 'GET' || method === 'HEAD') && url.pathname === '/favicon.ico') {
    return { status: 204, body: null };
  }
  if ((method === 'GET' || method === 'HEAD') && url.pathname === '/internal/health') {
    return { status: 200, body: { ok: true, service: 'gpto-insights-gateway', time: new Date().toISOString() } };
  }

  if (url.pathname.startsWith('/internal/') || url.pathname.startsWith('/v1/')) {
    requireAuthOrThrow(request);
  }

  if (method === 'GET' && url.pathname === '/v1/dashboard/overview') return readDashboardOverview(request);
  if (method === 'GET' && url.pathname === '/v1/dashboard/bundle') return readDashboardBundle(request);
  if (method === 'GET' && url.pathname === '/v1/dashboard/report-bundle') return readDashboardReportBundle(request);
  const moduleMatch = url.pathname.match(/^\/v1\/dashboard\/module\/([^/]+)$/);
  if (method === 'GET' && moduleMatch) return readDashboardModule(request, moduleMatch[1]);
  if (method === 'GET' && url.pathname === '/v1/dashboard/gold') return readDashboardGold(request);
  if (method === 'GET' && url.pathname === '/v1/dashboard/stats') return readDashboardStats(request);
  if (method === 'GET' && url.pathname === '/v1/dashboard/export-data') return readDashboardExportData(request);
  if (method === 'GET' && url.pathname === '/v1/dashboard/export') return readDashboardExport(request);

  if (method === 'GET' && url.pathname === '/v1/llm-mentions/overview') return readLlmMentionsOverview(request);
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/bundle') return readLlmMentionsBundle(request);
  if (method === 'GET' && url.pathname === '/v1/llm-mentions') return readLegacyLlmMentions(request);
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/trends') return readLlmTrends(request);
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/competitors') return readLlmCompetitors(request);
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/prompt-intelligence') return readPromptIntelligence(request);
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/source-gap') return readSourceGap(request);

  const llmEndpointMatch = url.pathname.match(/^\/v1\/llm-mentions\/(aggregated|top-pages|top-domains|search|locations)$/);
  if (method === 'GET' && llmEndpointMatch) return readLlmEndpoint(request, llmEndpointMatch[1]);
  if (method === 'GET' && url.pathname === '/v1/llm-mentions/raw') return readRawSnapshots(request);
  if (method === 'POST' && url.pathname === '/v1/llm-mentions/raw') return writeRawRequest(request, await readJson(request));
  if ((method === 'GET' || method === 'POST') && url.pathname === '/v1/llm-mentions/prompt-refresh') return refreshPrompts(request);
  if (method === 'GET' && (url.pathname === '/v1/llm-mentions/tracked-prompts' || url.pathname === '/v1/llm-mentions/prompts')) return readTrackedPrompts(request);
  if (method === 'POST' && (url.pathname === '/v1/llm-mentions/tracked-prompts' || url.pathname === '/v1/llm-mentions/prompts')) return writeTrackedPrompt(request, await readJson(request));

  const trackedPromptMatch = url.pathname.match(/^\/v1\/llm-mentions\/tracked-prompts\/([^/]+)$/);
  if (trackedPromptMatch && (method === 'PATCH' || method === 'PUT')) return patchTrackedPrompt(request, trackedPromptMatch[1], await readJson(request));
  if (trackedPromptMatch && method === 'DELETE') return removeTrackedPrompt(request, trackedPromptMatch[1]);

  if (method === 'GET' && url.pathname === '/v1/sites') return { status: 200, body: await buildSitesList() };
  const siteConfigMatch = url.pathname.match(/^\/v1\/sites\/([^/]+)\/config$/);
  if (method === 'GET' && siteConfigMatch) return { status: 200, body: await buildSiteConfig(siteConfigMatch[1]) };
  if (method === 'GET' && url.pathname === '/v1/auth/me') return { status: 200, body: { user: getUserContext(request) } };

  if (method === 'POST' && url.pathname === '/internal/refresh/dashboard') return refreshDashboard(request, await readJson(request));
  if (method === 'POST' && url.pathname === '/internal/refresh/llm-mentions') return refreshLlmMentions(request, await readJson(request));
  if (method === 'POST' && url.pathname === '/internal/refresh/prewarm') return prewarmDashboard(await readJson(request));
  if (method === 'POST' && url.pathname === '/internal/refresh/process') return processRefreshJobs(await readJson(request));
  if ((method === 'GET' || method === 'POST') && url.pathname === '/internal/cron/refresh') {
    return runDashboardCronRefresh(method === 'POST' ? await readJson(request) : {});
  }

  if (method === 'POST' && url.pathname === '/internal/rollup/telemetry-daily') {
    return postTelemetryDailyRollup(request, await readJson(request));
  }
  if (method === 'GET' && url.pathname === '/internal/rollup/telemetry-daily/progress') {
    return getTelemetryDailyRollupProgress(request);
  }

  return { status: 404, body: { error: 'Not found' } };
}
