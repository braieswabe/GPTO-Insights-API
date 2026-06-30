const NOT_FOUND_TITLE_PATTERNS = [
  /\bpage\s+not\s+found\b/i,
  /\b404\b/i,
  /\bnot\s+found\b/i,
  /\bnothing\s+found\b/i,
];

const WORDPRESS_EDITOR_QUERY_PARAMS = new Set([
  '_vcnonce',
  'customize_autosaved',
  'customize_changeset_uuid',
  'customize_messenger_channel',
  'customize_theme',
  'ct_builder',
  'elementor-preview',
  'et_fb',
  'fl_builder',
  'oxygen_iframe',
  'preview_id',
  'preview_nonce',
  'vc_editable',
  'vc_post_id',
  'wp_customize',
]);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function booleanValue(value) {
  return value === true || value === 'true';
}

function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function isHttpTelemetryUrl(value) {
  const url = stringValue(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isNotFoundTelemetryPage(page = {}, context = {}) {
  const pageRecord = asRecord(page);
  const contextRecord = asRecord(context);
  const pageQuality = asRecord(contextRecord.pageQuality);
  const coveragePage = asRecord(asRecord(contextRecord.coverage).page);

  if (booleanValue(pageRecord.isNotFound) || booleanValue(pageQuality.isNotFound) || booleanValue(coveragePage.isNotFound)) {
    return true;
  }

  const titles = [
    stringValue(pageRecord.title),
    stringValue(contextRecord.title),
    stringValue(coveragePage.title),
  ].filter(Boolean);

  return titles.some((title) => NOT_FOUND_TITLE_PATTERNS.some((pattern) => pattern.test(title)));
}

export function isWordPressAdminOrEditorTelemetryUrl(value) {
  if (!isHttpTelemetryUrl(value)) return false;
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    if (pathname === '/wp-admin' || pathname.startsWith('/wp-admin/')) return true;
    if (pathname === '/wp-login.php') return true;

    for (const param of WORDPRESS_EDITOR_QUERY_PARAMS) {
      if (parsed.searchParams.has(param)) return true;
    }

    const preview = parsed.searchParams.get('preview');
    return preview === 'true' || preview === '1';
  } catch {
    return false;
  }
}

export function isTelemetryPageEligibleForPageViewTotals(page = {}) {
  const pageRecord = asRecord(page);
  return isHttpTelemetryUrl(pageRecord.url) && !isWordPressAdminOrEditorTelemetryUrl(pageRecord.url);
}

export function isTelemetryPageEligibleForTopPages(page = {}, context = {}) {
  return isTelemetryPageEligibleForPageViewTotals(page) && !isNotFoundTelemetryPage(page, context);
}

export function normalizeTelemetryTopPageUrl(value) {
  const url = stringValue(value);
  if (!url || !isTelemetryPageEligibleForPageViewTotals({ url })) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname || '/'}`;
  } catch {
    return null;
  }
}

export function telemetryPageUrlKey(value) {
  if (!isHttpTelemetryUrl(value)) return null;
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

export function filterValidTelemetryTopPages(pages, { knownNotFoundUrlKeys } = {}) {
  if (!Array.isArray(pages)) return [];
  return pages.filter((page) => {
    if (!isTelemetryPageEligibleForTopPages(page)) return false;
    const key = telemetryPageUrlKey(page?.url);
    return !key || !knownNotFoundUrlKeys?.has(key);
  });
}

export function aggregateValidTelemetryTopPages(pages, { knownNotFoundUrlKeys, limit = Number.POSITIVE_INFINITY } = {}) {
  const aggregated = new Map();

  for (const page of filterValidTelemetryTopPages(pages, { knownNotFoundUrlKeys })) {
    const normalizedUrl = normalizeTelemetryTopPageUrl(page?.url);
    const key = telemetryPageUrlKey(normalizedUrl);
    if (!normalizedUrl || !key) continue;

    const count = numberValue(page.count) ?? numberValue(page.views) ?? numberValue(page.pageViews) ?? 1;
    const views = numberValue(page.views) ?? numberValue(page.count) ?? numberValue(page.pageViews) ?? 1;
    const current = aggregated.get(key) || {
      url: normalizedUrl,
      count: 0,
      views: 0,
      path: stringValue(page.path) || undefined,
      title: stringValue(page.title) || undefined,
    };
    current.count += count;
    current.views += views;
    current.path = current.path || stringValue(page.path) || undefined;
    current.title = current.title || stringValue(page.title) || undefined;
    aggregated.set(key, current);
  }

  return Array.from(aggregated.values())
    .sort((a, b) => (b.views || 0) - (a.views || 0) || (b.count || 0) - (a.count || 0))
    .slice(0, limit);
}
