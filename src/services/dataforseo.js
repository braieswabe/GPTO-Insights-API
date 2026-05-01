const DATAFORSEO_BASE_URL = 'https://api.dataforseo.com';

const LLM_MENTIONS_ENDPOINTS = {
  aggregated_metrics: '/v3/ai_optimization/llm_mentions/aggregated_metrics/live',
  cross_aggregated_metrics: '/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live',
  top_domains: '/v3/ai_optimization/llm_mentions/top_domains/live',
  top_pages: '/v3/ai_optimization/llm_mentions/top_pages/live',
  search: '/v3/ai_optimization/llm_mentions/search/live',
};

export function dataForSeoAuthHeader() {
  const explicit = process.env.DATAFORSEO_AUTH_HEADER;
  if (explicit) return explicit.toLowerCase().startsWith('basic ') ? explicit : `Basic ${explicit}`;
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) return null;
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

export function canCallDataForSeo(endpoint, payload) {
  return Boolean(dataForSeoAuthHeader() && payload && LLM_MENTIONS_ENDPOINTS[endpoint]);
}

export async function fetchLlmMentionsLive(endpoint, payload) {
  const auth = dataForSeoAuthHeader();
  const path = LLM_MENTIONS_ENDPOINTS[endpoint];
  if (!auth || !payload || !path) return null;

  const response = await fetch(`${DATAFORSEO_BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify([payload]),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`DataForSEO request failed (${response.status})`);
    error.statusCode = response.status;
    error.vendorResponse = json;
    throw error;
  }
  return json;
}
