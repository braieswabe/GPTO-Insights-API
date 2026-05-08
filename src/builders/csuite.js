import { db } from '../db.js';
import { boundsFromInput, boundsDaySpan } from '../dashboard-range.js';
import { buildAuthority } from './authority.js';
import { buildConfusion } from './confusion.js';
import { buildLlmMentionsOverview } from './llm-mentions.js';
import { buildLlmMentionsCompetitors } from './llm-mentions.js';
import { buildTelemetry } from './telemetry.js';
import { clampScore, formatTrendPercent, getScoreBand, getScoreSeverity, isSiteDomainMatch, trendPercentNumber } from '../lib/scoring.js';

const DEFAULT_AUTHORITY_TARGET = Number(process.env.CSUITE_TARGET_AUTHORITY || 90);
const DEFAULT_SENTIMENT_TARGET = Number(process.env.CSUITE_TARGET_SENTIMENT || 80);
const DEFAULT_AI_VISIBILITY_TARGET = Number(process.env.CSUITE_TARGET_AI_VISIBILITY || 90);

function metric(score, { target = null, trend = null, supportingMetric = null } = {}) {
  const numericScore = typeof score === 'number' && Number.isFinite(score) ? clampScore(score) : null;
  return {
    score: numericScore,
    target,
    trend,
    band: getScoreBand(numericScore),
    severity: getScoreSeverity(numericScore),
    supportingMetric: supportingMetric || null,
  };
}

async function loadPriorAuthority(sql, siteIds, days, end) {
  const priorEnd = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const priorStart = new Date(priorEnd.getTime() - days * 24 * 60 * 60 * 1000);
  if (!siteIds.length) return null;
  const rows = await sql`
    SELECT authority_score
    FROM authority_signals
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND window_end >= ${priorStart}
      AND window_start <= ${priorEnd}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  if (!rows.length) return null;
  const valid = rows.filter((r) => typeof r.authority_score === 'number' && Number.isFinite(r.authority_score));
  if (!valid.length) return null;
  return Math.round(valid.reduce((sum, r) => sum + r.authority_score, 0) / valid.length);
}

function deriveSentimentScore({ authorityScore, confusionScore, aiComposite }) {
  const components = [];
  if (typeof authorityScore === 'number' && authorityScore > 0) components.push({ value: authorityScore, weight: 0.4 });
  if (typeof confusionScore === 'number' && confusionScore > 0) components.push({ value: 100 - confusionScore, weight: 0.3 });
  if (typeof aiComposite === 'number' && aiComposite >= 0) components.push({ value: aiComposite, weight: 0.3 });
  if (!components.length) return null;
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const score = components.reduce((sum, c) => sum + c.value * c.weight, 0) / totalWeight;
  return clampScore(score);
}

function competitorRankFromComparison(comparison, siteDomain) {
  if (!Array.isArray(comparison) || comparison.length === 0 || !siteDomain) return null;
  const sorted = [...comparison].sort((a, b) => {
    const aScore = Number(a.shareOfVoice ?? a.aiSearchVolume ?? a.mentions ?? 0);
    const bScore = Number(b.shareOfVoice ?? b.aiSearchVolume ?? b.mentions ?? 0);
    return bScore - aScore;
  });
  const idx = sorted.findIndex((row) => isSiteDomainMatch(row.target || row.domain, siteDomain));
  if (idx === -1) return null;
  return {
    position: idx + 1,
    total: sorted.length,
  };
}

async function loadMonthlyGrowth(sql, siteIds, end) {
  if (!siteIds.length) {
    return { traffic: 0, authority: 0, sentiment: 0 };
  }
  const monthEnd = new Date(end);
  const monthStart = new Date(monthEnd);
  monthStart.setDate(monthEnd.getDate() - 30);
  const priorEnd = new Date(monthStart);
  const priorStart = new Date(priorEnd);
  priorStart.setDate(priorEnd.getDate() - 30);

  const [currentRow, priorRow] = await Promise.all([
    sql`
      SELECT COALESCE(SUM(visits), 0)::int AS visits, COALESCE(SUM(page_views), 0)::int AS page_views
      FROM dashboard_rollups_daily
      WHERE site_id = ANY(${siteIds}::uuid[])
        AND day >= ${monthStart}
        AND day <= ${monthEnd}
    `,
    sql`
      SELECT COALESCE(SUM(visits), 0)::int AS visits, COALESCE(SUM(page_views), 0)::int AS page_views
      FROM dashboard_rollups_daily
      WHERE site_id = ANY(${siteIds}::uuid[])
        AND day >= ${priorStart}
        AND day <= ${priorEnd}
    `,
  ]);

  const cur = currentRow[0] || { visits: 0, page_views: 0 };
  const prev = priorRow[0] || { visits: 0, page_views: 0 };
  const trafficGrowth = prev.visits > 0 ? ((cur.visits - prev.visits) / prev.visits) * 100 : null;
  return {
    traffic: trafficGrowth !== null ? Number(trafficGrowth.toFixed(1)) : 0,
    pageViewsGrowth: prev.page_views > 0 ? Number((((cur.page_views - prev.page_views) / prev.page_views) * 100).toFixed(1)) : 0,
  };
}

async function loadMonthlyInsights(sql, siteIds, end) {
  if (!siteIds.length) return [];
  const monthStart = new Date(end);
  monthStart.setDate(end.getDate() - 30);

  const rows = await sql`
    SELECT
      'authority_change'::text AS kind,
      created_at,
      authority_score,
      blockers,
      window_start,
      window_end
    FROM authority_signals
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND created_at >= ${monthStart}
    ORDER BY created_at DESC
    LIMIT 5
  `;
  const insights = rows.map((row, idx) => ({
    id: `authority-${idx}`,
    type: row.authority_score >= 70 ? 'positive' : 'warning',
    title: row.authority_score >= 70 ? 'Authority score holding strong' : 'Authority score needs attention',
    description: `Authority signal recorded at ${row.authority_score}/100${Array.isArray(row.blockers) && row.blockers.length ? ` with ${row.blockers.length} active blocker(s).` : '.'}`,
    impact: row.authority_score >= 70 ? 'High - Sustains AI search visibility' : 'Medium - Monitor blockers and trust signals',
    date: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  }));

  if (!insights.length) {
    insights.push({
      id: 'authority-empty',
      type: 'info',
      title: 'No major authority changes this month',
      description: 'No new authority signals were captured in the last 30 days.',
      impact: 'Low - Continue monitoring',
      date: new Date().toISOString(),
    });
  }
  return insights;
}

export async function buildCsuite(input) {
  const { siteId } = input;
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }

  const sql = db();
  const { start, end } = boundsFromInput(input);
  const days = boundsDaySpan({ start, end });

  const [siteRow] = await sql`SELECT id, domain FROM sites WHERE id = ${siteId}::uuid LIMIT 1`;
  if (!siteRow) {
    const error = new Error('Site not found');
    error.statusCode = 404;
    throw error;
  }

  const [authority, confusion, llmMentions, telemetry, competitors, priorAuthority, monthlyGrowth, monthlyInsights] = await Promise.all([
    buildAuthority(input),
    buildConfusion(input),
    buildLlmMentionsOverview({ siteId, days, windowStart: start, windowEnd: end, sources: ['chat_gpt', 'google_ai_overviews'] }).catch(() => null),
    buildTelemetry(input),
    buildLlmMentionsCompetitors({ siteId, source: 'chat_gpt' }).catch(() => null),
    loadPriorAuthority(sql, [siteId], days, end),
    loadMonthlyGrowth(sql, [siteId], end),
    loadMonthlyInsights(sql, [siteId], end),
  ]);

  const aiComposite = llmMentions?.aiVisibility?.composite ?? null;
  const aiVisibilityTrend = telemetry?.trend?.pageViews
    ? Number((telemetry.trend.pageViews * 100).toFixed(1))
    : 0;
  const authorityTrend =
    typeof priorAuthority === 'number' && priorAuthority >= 0
      ? Number((authority.authorityScore - priorAuthority).toFixed(1))
      : 0;

  const sentiment = deriveSentimentScore({
    authorityScore: authority.authorityScore,
    confusionScore: confusion?.confidence?.score ?? null,
    aiComposite,
  });
  const sentimentTrend = telemetry?.trend?.searches
    ? Number((telemetry.trend.searches * 100).toFixed(1))
    : 0;

  const comparisonRows = competitors?.comparison || [];
  const competitorRankBlock = competitorRankFromComparison(comparisonRows, siteRow.domain);
  const competitorBlock = competitorRankBlock
    ? {
        position: competitorRankBlock.position,
        total: competitorRankBlock.total,
        trend: 0,
        comparison: comparisonRows.map((row, index) => ({
          rank: index + 1,
          target: row.target || row.domain || 'Competitor',
          mentions: row.mentions ?? null,
          aiSearchVolume: row.aiSearchVolume ?? null,
          shareOfVoice: row.shareOfVoice ?? null,
          isSelf: isSiteDomainMatch(row.target || row.domain, siteRow.domain),
        })),
      }
    : null;

  return {
    site: { id: siteRow.id, domain: siteRow.domain },
    period: { start: start.toISOString(), end: end.toISOString(), days },
    authorityScore: metric(authority.authorityScore, {
      target: DEFAULT_AUTHORITY_TARGET,
      trend: authorityTrend,
      supportingMetric: { trustSignals: authority.trustSignals?.length ?? 0, blockers: authority.blockers?.length ?? 0 },
    }),
    sentimentScore: metric(sentiment, {
      target: DEFAULT_SENTIMENT_TARGET,
      trend: sentimentTrend,
      supportingMetric: {
        confusionScore: confusion?.confidence?.score ?? null,
        aiComposite,
      },
    }),
    aiSearchVisibility: metric(aiComposite, {
      target: DEFAULT_AI_VISIBILITY_TARGET,
      trend: aiVisibilityTrend,
      supportingMetric: {
        mentions: llmMentions?.summary?.metrics?.mentions ?? null,
        aiSearchVolume: llmMentions?.summary?.metrics?.aiSearchVolume ?? null,
      },
    }),
    competitorRank: competitorBlock,
    monthlyGrowth: {
      traffic: monthlyGrowth.traffic,
      pageViewsGrowth: monthlyGrowth.pageViewsGrowth,
      authority: authorityTrend,
      sentiment: sentimentTrend,
      trafficLabel: formatTrendPercent((monthlyGrowth.traffic ?? 0) / 100),
    },
    monthlyInsights,
    pulseBlends: {
      telemetry: telemetry?.totals ?? null,
      trendPctLabel: telemetry?.trendPctLabel ?? null,
      trendPct: telemetry?.trendPct ?? null,
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function buildMonthlyInsights(input) {
  const { siteId } = input;
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }
  const sql = db();
  const { end } = boundsFromInput(input);
  const insights = await loadMonthlyInsights(sql, [siteId], end);
  return { siteId, insights, generatedAt: new Date().toISOString() };
}

export { trendPercentNumber as csuiteTrendPercent };
