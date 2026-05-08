export const MODEL_VERSION = 'gpto.dashboard.insights.v2.1';
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
  overview: 60 * 60,
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
  gold: 30 * 60,
  stats: 60 * 60,
  export_data: 30 * 60,
  csuite: 30 * 60,
  monthly_insights: 60 * 60,
  ai_report: 6 * 60 * 60,
};

export const DASHBOARD_MODULE_ALIASES = {
  'search-diagnostics': 'search_diagnostics',
  'executive-summary': 'executive_summary',
  'ai-readability': 'ai_readability',
  'llm-mentions-overview': 'llm_mentions_overview',
};

export function normalizeDashboardModuleKey(value) {
  const key = String(value || '').trim();
  return DASHBOARD_MODULE_ALIASES[key] || key;
}

export function ttlForModule(moduleKey) {
  return MODULE_TTL_SECONDS[normalizeDashboardModuleKey(moduleKey)] || 30 * 60;
}

export function normalizePortal(value) {
  if (value === 'admin' || value === 'customer' || value === 'employee') return value;
  return 'employee';
}

export function normalizeRange(value) {
  return value === '30d' ? '30d' : '7d';
}

export function rangeToDays(rangeKey) {
  if (rangeKey === '30d') return 30;
  if (rangeKey === 'custom') return 7;
  return 7;
}
