import { db } from '../db.js';
import { aggregateTelemetrySeriesByGranularity, boundsFromInput, boundsDaySpan } from '../dashboard-range.js';
import { trendPercentNumber, formatTrendPercent } from '../lib/scoring.js';

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

export async function buildTelemetry(input) {
  const { siteId, rangeKey } = input;
  const sql = db();
  const siteIds = await getScopedSiteIds(sql, siteId);
  const { start, end } = boundsFromInput(input);
  const seriesGranularity = input.seriesGranularity || 'day';

  if (siteIds.length === 0) {
    return emptyTelemetry(rangeKey, start, end, seriesGranularity);
  }

  const [rows, llmSignals] = await Promise.all([
    sql`
      SELECT day, visits, page_views, searches, interactions, top_pages, top_intents
      FROM dashboard_rollups_daily
      WHERE site_id = ANY(${siteIds}::uuid[])
        AND day >= ${start}
        AND day <= ${end}
      ORDER BY day ASC
    `,
    siteId ? loadLlmMentionsSignals(input, sql) : Promise.resolve(null),
  ]);

  if (rows.length === 0) {
    return { ...emptyTelemetry(rangeKey, start, end, seriesGranularity), llmMentionsSignals: llmSignals };
  }

  const dailySeries = rows.map((row) => ({
    date: new Date(row.day).toISOString().slice(0, 10),
    visits: row.visits || 0,
    pageViews: row.page_views || 0,
    searches: row.searches || 0,
    interactions: row.interactions || 0,
  }));
  const series = aggregateTelemetrySeriesByGranularity(dailySeries, seriesGranularity);

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

  const trendPct = {
    visits: trendPercentNumber(trend.visits),
    pageViews: trendPercentNumber(trend.pageViews),
    searches: trendPercentNumber(trend.searches),
    interactions: trendPercentNumber(trend.interactions),
  };
  const trendPctLabel = {
    visits: formatTrendPercent(trend.visits),
    pageViews: formatTrendPercent(trend.pageViews),
    searches: formatTrendPercent(trend.searches),
    interactions: formatTrendPercent(trend.interactions),
  };

  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    totals,
    trend,
    trendPct,
    trendPctLabel,
    series,
    seriesGranularity,
    topPages: mergeCountedJson(rows, 'top_pages', 'url'),
    topIntents: mergeCountedJson(rows, 'top_intents', 'intent'),
    llmMentionsSignals: llmSignals,
  };
}

function emptyTelemetry(rangeKey, start, end, seriesGranularity = 'day') {
  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    totals: { visits: 0, pageViews: 0, searches: 0, interactions: 0 },
    trend: { visits: 0, pageViews: 0, searches: 0, interactions: 0 },
    trendPct: { visits: null, pageViews: null, searches: null, interactions: null },
    trendPctLabel: { visits: null, pageViews: null, searches: null, interactions: null },
    series: [],
    seriesGranularity,
    topPages: [],
    topIntents: [],
    llmMentionsSignals: null,
    insufficientData: { message: 'No cached telemetry rollups are available for this range yet.' },
  };
}

async function loadLlmMentionsSignals(input, sql) {
  if (!input?.siteId) return null;
  try {
    const { buildLlmMentionsOverview } = await import('./llm-mentions.js');
    const { start, end } = boundsFromInput(input);
    const days = boundsDaySpan({ start, end });
    const overview = await buildLlmMentionsOverview({
      siteId: input.siteId,
      days,
      windowStart: start,
      windowEnd: end,
      sources: ['chat_gpt', 'google_ai_overviews'],
    });
    if (!overview) return null;
    const ai = overview.aiVisibility || null;
    const metrics = overview.summary?.metrics || {};
    return {
      composite: ai?.composite ?? null,
      band: ai?.band ?? null,
      mentions: metrics.mentions ?? null,
      aiSearchVolume: metrics.aiSearchVolume ?? null,
      impressions: metrics.impressions ?? null,
      lastUpdatedAt: overview.summary?.lastUpdatedAt || null,
      freshness: ai?.freshness
        ? {
            state: ai.freshness.state,
            summary: ai.freshness.summary,
            sourceContext: ai.freshness.sourceContext,
          }
        : null,
      sourceContext: ai?.sourceContext || null,
    };
  } catch (error) {
    console.error('telemetry.loadLlmMentionsSignals failed (non-fatal):', error?.message || error);
    return null;
  }
}

async function getScopedSiteIds(sql, siteId) {
  if (siteId) return [siteId];
  const rows = await sql`SELECT id FROM sites ORDER BY created_at DESC`;
  return rows.map((r) => r.id);
}
