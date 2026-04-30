export const MODEL_VERSION = 'gpto.dashboard.insights.v1';
export const EMPTY_SITE_UUID = '00000000-0000-0000-0000-000000000000';

export const DASHBOARD_MODULES = [
  'overview',
  'telemetry',
  'authority',
  'confusion',
  'coverage',
  'schema',
  'index',
  'journey',
  'experience',
  'search_diagnostics',
  'executive_summary',
  'ai_readability',
  'llm_mentions_overview',
];

export const MODULE_TTL_SECONDS = {
  overview: 15 * 60,
  telemetry: 15 * 60,
  index: 15 * 60,
  authority: 30 * 60,
  confusion: 30 * 60,
  schema: 30 * 60,
  coverage: 60 * 60,
  executive_summary: 30 * 60,
  journey: 30 * 60,
  search_diagnostics: 30 * 60,
  experience: 30 * 60,
  ai_readability: 60 * 60,
  llm_mentions_overview: 6 * 60 * 60,
};

export function ttlForModule(moduleKey) {
  return MODULE_TTL_SECONDS[moduleKey] || 30 * 60;
}

export function normalizePortal(value) {
  if (value === 'admin' || value === 'customer' || value === 'employee') return value;
  return 'employee';
}

export function normalizeRange(value) {
  return value === '30d' ? '30d' : '7d';
}

export function rangeToDays(rangeKey) {
  return rangeKey === '30d' ? 30 : 7;
}
