/** Mirrors GPTO `packages/dashboard-insights/src/dashboard-range.ts` for gateway parity. */

const MAX_CUSTOM_SPAN_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * @param {URLSearchParams} searchParams
 * @returns {{ rangeKey: '7d' | '30d' | 'custom', customStart: string | null, customEnd: string | null }}
 */
export function parseDashboardRangeFromSearchParams(searchParams) {
  const raw = searchParams.get('range');
  const customStart = searchParams.get('start');
  const customEnd = searchParams.get('end');
  if (raw === '30d') return { rangeKey: '30d', customStart: null, customEnd: null };
  if (raw === 'custom' && customStart && customEnd) return { rangeKey: 'custom', customStart, customEnd };
  return { rangeKey: '7d', customStart: null, customEnd: null };
}

/**
 * @param {Record<string, unknown>} body
 */
export function parseDashboardRangeFromBody(body) {
  const raw = typeof body.range === 'string' ? body.range : null;
  const customStart = typeof body.start === 'string' ? body.start : typeof body.customStart === 'string' ? body.customStart : null;
  const customEnd = typeof body.end === 'string' ? body.end : typeof body.customEnd === 'string' ? body.customEnd : null;
  if (raw === '30d') return { rangeKey: '30d', customStart: null, customEnd: null };
  if (raw === 'custom' && customStart && customEnd) return { rangeKey: 'custom', customStart, customEnd };
  return { rangeKey: '7d', customStart: null, customEnd: null };
}

/**
 * @param {string | null | undefined} value
 * @returns {'day' | 'week' | 'month'}
 */
export function parseSeriesGranularity(value) {
  if (value === 'week' || value === 'month') return value;
  return 'day';
}

/**
 * @param {'7d' | '30d' | 'custom'} rangeKey
 * @param {string | null | undefined} customStart
 * @param {string | null | undefined} customEnd
 * @returns {{ start: Date, end: Date, rangeKey: '7d' | '30d' | 'custom' }}
 */
export function resolveDashboardTimeBounds(rangeKey, customStart, customEnd) {
  const now = new Date();

  if (rangeKey === 'custom' && customStart && customEnd) {
    let start = new Date(customStart);
    let end = new Date(customEnd);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      if (start.getTime() > end.getTime()) {
        const swap = start;
        start = end;
        end = swap;
      }
      if (end.getTime() > now.getTime()) {
        end = now;
      }
      if (end.getTime() - start.getTime() > MAX_CUSTOM_SPAN_MS) {
        start = new Date(end.getTime() - MAX_CUSTOM_SPAN_MS);
      }
      return { start, end, rangeKey: 'custom' };
    }
  }

  const end = new Date(now);
  const start = new Date(end);
  const days = rangeKey === '30d' ? 30 : 7;
  start.setDate(end.getDate() - days);
  return { start, end, rangeKey: rangeKey === '30d' ? '30d' : '7d' };
}

/**
 * @param {{ start: Date, end: Date }} bounds
 */
export function boundsDaySpan(bounds) {
  return Math.max(1, Math.min(90, Math.ceil((bounds.end.getTime() - bounds.start.getTime()) / 86400000)));
}

/**
 * @param {string} portalScope
 * @param {{ start: Date, end: Date, rangeKey: string }} bounds
 * @param {'day' | 'week' | 'month'} seriesGranularity
 */
export function buildDashboardCacheParams(portalScope, bounds, seriesGranularity) {
  const p = { portalScope };
  if (bounds.rangeKey === 'custom') {
    p.start = bounds.start.toISOString().slice(0, 10);
    p.end = bounds.end.toISOString().slice(0, 10);
  }
  if (seriesGranularity && seriesGranularity !== 'day') {
    p.seriesGranularity = seriesGranularity;
  }
  return p;
}

/**
 * @param {{ windowStart?: Date | null, windowEnd?: Date | null, rangeKey?: string, params?: { start?: string, end?: string } }} input
 * @returns {{ start: Date, end: Date }}
 */
export function boundsFromInput(input) {
  if (input.windowStart != null && input.windowEnd != null) {
    return { start: new Date(input.windowStart), end: new Date(input.windowEnd) };
  }
  const customStart = input.params?.start ?? null;
  const customEnd = input.params?.end ?? null;
  const rk = input.rangeKey === '30d' ? '30d' : input.rangeKey === 'custom' ? 'custom' : '7d';
  const b = resolveDashboardTimeBounds(rk, customStart, customEnd);
  return { start: b.start, end: b.end };
}

/**
 * @param {string} dateStr
 * @param {'day' | 'week' | 'month'} granularity
 */
function bucketLabelForGranularity(dateStr, granularity) {
  if (granularity === 'day') return dateStr;
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  if (granularity === 'month') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const day = d.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + mondayOffset);
  return monday.toISOString().slice(0, 10);
}

/**
 * @template T
 * @param {T[]} series
 * @param {'day' | 'week' | 'month'} granularity
 */
export function aggregateTelemetrySeriesByGranularity(series, granularity) {
  if (granularity === 'day' || !series || series.length === 0) return series;

  const map = new Map();
  for (const row of series) {
    const key = bucketLabelForGranularity(row.date, granularity);
    const cur = map.get(key) ?? { visits: 0, pageViews: 0, searches: 0, interactions: 0 };
    cur.visits += row.visits;
    cur.pageViews += row.pageViews;
    cur.searches += row.searches;
    cur.interactions += row.interactions;
    map.set(key, cur);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sums]) => ({ date, ...sums }));
}
