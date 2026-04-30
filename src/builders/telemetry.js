import { db } from '../db.js';
import { rangeToDays } from '../types.js';

function dateWindow(rangeKey) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - rangeToDays(rangeKey));
  return { start, end };
}

function computeTrend(current, previous) {
  if (!previous) return current > 0 ? 1 : 0;
  return (current - previous) / previous;
}

function mergeCountedJson(rows, field, keyName, limit = 10) {
  const map = new Map();
  for (const row of rows) {
    const items = Array.isArray(row[field]) ? row[field] : [];
    for (const item of items) {
      const key = item?.[keyName];
      if (!key) continue;
      const current = map.get(key) || { ...item, count: 0 };
      current.count += Number(item.count || item.views || item.pageViews || 0);
      map.set(key, current);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, limit);
}

export async function buildTelemetry({ siteId, rangeKey }) {
  const sql = db();
  const siteIds = await getScopedSiteIds(sql, siteId);
  const { start, end } = dateWindow(rangeKey);

  if (siteIds.length === 0) {
    return emptyTelemetry(rangeKey, start, end);
  }

  const rows = await sql`
    SELECT day, visits, page_views, searches, interactions, top_pages, top_intents
    FROM dashboard_rollups_daily
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND day >= ${start}
      AND day <= ${end}
    ORDER BY day ASC
  `;

  if (rows.length === 0) {
    return emptyTelemetry(rangeKey, start, end);
  }

  const series = rows.map((row) => ({
    date: new Date(row.day).toISOString().slice(0, 10),
    visits: row.visits || 0,
    pageViews: row.page_views || 0,
    searches: row.searches || 0,
    interactions: row.interactions || 0,
  }));

  const totals = rows.reduce(
    (sum, row) => ({
      visits: sum.visits + (row.visits || 0),
      pageViews: sum.pageViews + (row.page_views || 0),
      searches: sum.searches + (row.searches || 0),
      interactions: sum.interactions + (row.interactions || 0),
    }),
    { visits: 0, pageViews: 0, searches: 0, interactions: 0 }
  );

  const first = series[0] || {};
  const last = series[series.length - 1] || {};
  const trend = {
    visits: computeTrend(last.visits || 0, first.visits || 0),
    pageViews: computeTrend(last.pageViews || 0, first.pageViews || 0),
    searches: computeTrend(last.searches || 0, first.searches || 0),
    interactions: computeTrend(last.interactions || 0, first.interactions || 0),
  };

  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    totals,
    trend,
    series,
    topPages: mergeCountedJson(rows, 'top_pages', 'url'),
    topIntents: mergeCountedJson(rows, 'top_intents', 'intent'),
    llmMentionsSignals: null,
  };
}

function emptyTelemetry(rangeKey, start, end) {
  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    totals: { visits: 0, pageViews: 0, searches: 0, interactions: 0 },
    trend: { visits: 0, pageViews: 0, searches: 0, interactions: 0 },
    series: [],
    topPages: [],
    topIntents: [],
    llmMentionsSignals: null,
    insufficientData: { message: 'No cached telemetry rollups are available for this range yet.' },
  };
}

async function getScopedSiteIds(sql, siteId) {
  if (siteId) return [siteId];
  const rows = await sql`SELECT id FROM sites ORDER BY created_at DESC`;
  return rows.map((r) => r.id);
}
