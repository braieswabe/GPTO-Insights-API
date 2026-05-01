export const DEFAULT_LLM_MENTION_SOURCES = ['chat_gpt', 'google_ai_overviews'];

export function requireSiteId(searchOrValue) {
  const value = typeof searchOrValue === 'string' ? searchOrValue : searchOrValue?.get?.('siteId');
  if (!value) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

export function normalizeSources(value, fallback = DEFAULT_LLM_MENTION_SOURCES) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const sources = raw
    .map((source) => String(source || '').trim())
    .filter((source) => source === 'chat_gpt' || source === 'google_ai_overviews');
  return sources.length > 0 ? sources : fallback;
}

export function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

export function parsePagination(search) {
  return {
    limit: parsePositiveInt(search.get('limit'), 50, { min: 1, max: 200 }),
    offset: parsePositiveInt(search.get('offset'), 0, { min: 0, max: 100000 }),
  };
}

export function missingFreshness() {
  return {
    status: 'missing',
    generatedAt: null,
    sourceWatermarkAt: null,
    expiresAt: null,
    stale: true,
    error: null,
  };
}

export function computedFreshness() {
  return {
    status: 'computed',
    generatedAt: new Date().toISOString(),
    sourceWatermarkAt: null,
    expiresAt: null,
    stale: false,
    error: null,
  };
}

export function responseEnvelope({ key, data, freshness, stale = false, refresh = null, generatedAt = null }) {
  return {
    data,
    freshness: { [key]: freshness || computedFreshness() },
    generatedAt: generatedAt || freshness?.generatedAt || new Date().toISOString(),
    stale,
    refreshQueued: refresh?.queued || false,
    refreshQueueReason: refresh?.reason || null,
    jobId: refresh?.jobId || null,
  };
}

export function ok(body) {
  return { status: 200, body };
}
