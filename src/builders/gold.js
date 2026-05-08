import { db } from '../db.js';
import { boundsFromInput, boundsDaySpan } from '../dashboard-range.js';
import { buildTelemetry } from './telemetry.js';
import { buildAuthority } from './authority.js';
import { buildConfusion } from './confusion.js';
import { buildCoverage } from './coverage.js';
import { buildExperience } from './experience.js';
import { buildJourney } from './journey.js';
import { buildLlmMentionsOverview } from './llm-mentions.js';
import {
  averageEngagementScore,
  buildExperienceHealth,
  clampScore,
  getScoreBand,
  getScoreSeverity,
} from '../lib/scoring.js';

function trendSymbol(value) {
  if (value > 0.1) return '↑';
  if (value < -0.1) return '↓';
  return '→';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function scoreState(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'Collecting';
  if (score >= 75) return 'Strong';
  if (score >= 50) return 'Building';
  if (score >= 25) return 'Limited';
  return 'Needs attention';
}

function metricValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : 'Collecting';
}

function buildVisitorBehaviorScore({ confusion, telemetry, experience, journey }) {
  const blend = buildExperienceHealth(confusion, experience, telemetry);
  if (blend.score !== null) return blend.score;
  const engagement = averageEngagementScore(experience);
  if (engagement !== null) return engagement;
  if (telemetry?.totals?.pageViews > 0) {
    const trendBoost = Number(telemetry?.trend?.visits || 0);
    const journeyDepth = (journey?.rows || []).length;
    const baseline = 45;
    const adjusted = baseline + Math.min(15, journeyDepth * 1.5) + Math.max(-10, Math.min(15, trendBoost * 25));
    return clampScore(Math.round(adjusted));
  }
  return null;
}

function buildCustomerInsights({
  telemetry,
  authority,
  confusion,
  coverage,
  experience,
  journey,
  llmMentions,
  technicalReadiness,
  conversionArchitecture,
  contentSignalQuality,
  growthReadiness,
  constraintRegister,
  changeLog,
  nextLogicalFocus,
}) {
  const aiVisibility = llmMentions?.aiVisibility || null;
  const aiExternal = aiVisibility?.external || {};
  const aiMetrics = aiExternal.metrics || llmMentions?.summary?.metrics || { mentions: null, aiSearchVolume: null, impressions: null };
  const friction = {
    deadEnds: Number(confusion?.totals?.deadEnds || 0),
    repeatedSearches: Number(confusion?.totals?.repeatedSearches || 0),
    dropOffs: Number(confusion?.totals?.dropOffs || 0),
  };
  const frictionTotal = friction.deadEnds + friction.repeatedSearches + friction.dropOffs;
  const coverageGaps = asArray(coverage?.gaps).map((gap) => gap.label || gap.detail || 'Coverage gap').slice(0, 8);
  const proofGaps = asArray(contentSignalQuality.proofGaps);
  const blockerRows = constraintRegister.map((item) => ({
    label: item.constraint,
    category: item.type,
    status: item.status,
  }));

  const visitorBehaviorScore = buildVisitorBehaviorScore({ confusion, telemetry, experience, journey });

  return {
    scorecards: [
      {
        id: 'ai-visibility',
        title: 'AI visibility',
        score: aiVisibility?.composite ?? null,
        band: aiVisibility?.band || getScoreBand(aiVisibility?.composite ?? null),
        severity: getScoreSeverity(aiVisibility?.composite ?? null),
        state: scoreState(aiVisibility?.composite),
        summary: aiVisibility?.narrative || 'AI visibility is being measured from LLM Mentions snapshots.',
        metrics: [
          { label: 'Mentions', value: metricValue(aiMetrics.mentions) },
          { label: 'AI search volume', value: metricValue(aiMetrics.aiSearchVolume) },
          { label: 'Impressions', value: metricValue(aiMetrics.impressions) },
        ],
        change: aiVisibility?.freshness?.summary || 'Snapshot freshness is not available yet.',
        nextAction: nextLogicalFocus,
      },
      {
        id: 'visitor-behavior',
        title: 'Visitor behavior',
        score: visitorBehaviorScore,
        band: getScoreBand(visitorBehaviorScore),
        severity: getScoreSeverity(visitorBehaviorScore),
        state: scoreState(visitorBehaviorScore),
        summary: frictionTotal > 0 ? 'Visitor friction is visible in recent behavioral signals.' : 'No major visitor friction is visible yet.',
        metrics: [
          { label: 'Visits', value: metricValue(telemetry?.totals?.visits) },
          { label: 'Page views', value: metricValue(telemetry?.totals?.pageViews) },
          { label: 'Searches', value: metricValue(telemetry?.totals?.searches) },
        ],
        change: telemetry?.trend?.visits > 0 ? 'Traffic is trending upward.' : telemetry?.trend?.visits < 0 ? 'Traffic is trending downward.' : 'Traffic is stable or still collecting.',
        nextAction: conversionArchitecture.primaryFrictionPoint,
      },
      {
        id: 'trust-readiness',
        title: 'Trust readiness',
        score: authority?.authorityScore ?? null,
        band: authority?.band || getScoreBand(authority?.authorityScore ?? null),
        severity: getScoreSeverity(authority?.authorityScore ?? null),
        state: scoreState(authority?.authorityScore),
        summary: technicalReadiness.framing,
        metrics: [
          { label: 'Authority score', value: metricValue(authority?.authorityScore) },
          { label: 'Coverage gaps', value: metricValue(coverageGaps.length) },
          { label: 'Proof gaps', value: metricValue(proofGaps.length) },
        ],
        change: contentSignalQuality.framing,
        nextAction: blockerRows[0]?.label || nextLogicalFocus,
      },
    ],
    aiVisibility: {
      score: aiVisibility?.composite ?? null,
      metrics: {
        mentions: aiMetrics.mentions ?? null,
        aiSearchVolume: aiMetrics.aiSearchVolume ?? null,
        impressions: aiMetrics.impressions ?? null,
      },
      freshnessSummary: aiVisibility?.freshness?.summary || 'No LLM Mentions snapshot freshness available yet.',
      sourceContext: aiVisibility?.sourceContext || aiVisibility?.freshness?.sourceContext || null,
      topDomains: asArray(aiExternal.topDomains),
      topPages: asArray(aiExternal.topPages),
      searchExamples: asArray(aiExternal.searchExamples),
      competitorComparison: asArray(aiExternal.competitorComparison),
      signals: asArray(aiVisibility?.signals),
    },
    visitorBehavior: {
      totals: telemetry?.totals || { visits: 0, pageViews: 0, searches: 0, interactions: 0 },
      trend: {
        visits: telemetry?.trend?.visits ?? 0,
        label: telemetry?.trend?.visits > 0 ? 'Increasing' : telemetry?.trend?.visits < 0 ? 'Decreasing' : 'Stable',
        direction: trendSymbol(telemetry?.trend?.visits || 0),
      },
      topPages: asArray(telemetry?.topPages).map((page) => ({
        url: page.url,
        title: page.title || null,
        views: page.views ?? page.count ?? 0,
      })),
      friction: {
        ...friction,
        summary: frictionTotal > 0 ? `${frictionTotal} friction signals are active.` : 'No major friction signals are active.',
      },
    },
    trustReadiness: {
      authorityScore: authority?.authorityScore ?? null,
      technicalStatus: technicalReadiness.status,
      contentStatus: contentSignalQuality.status,
      growthStatus: growthReadiness.status,
      blockers: blockerRows,
      proofGaps,
      coverageGaps,
      recommendedActions: [
        ...asArray(coverage?.recommendedFixes),
        nextLogicalFocus,
      ].filter(Boolean).slice(0, 5),
    },
    progress: {
      timeline: changeLog.map((item) => ({
        label: item.change,
        date: item.timestamp,
        status: item.status,
        detail: item.change,
      })),
      nextFocus: {
        title: nextLogicalFocus,
        why: constraintRegister[0]?.constraint || 'Continue improving the current foundation.',
        trigger: constraintRegister[0]?.type || 'Ongoing optimization',
        metric: aiVisibility?.composite != null ? `AI visibility ${aiVisibility.composite}/100` : 'Collecting visibility score',
      },
    },
  };
}

export async function buildGoldDashboard(input) {
  const { siteId, rangeKey } = input;
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }

  const sql = db();
  const [site] = await sql`
    SELECT id, domain, status
    FROM sites
    WHERE id = ${siteId}::uuid
    LIMIT 1
  `;
  if (!site) {
    const error = new Error('Site not found');
    error.statusCode = 404;
    throw error;
  }

  const { start, end } = boundsFromInput(input);
  const spanDays = boundsDaySpan({ start, end });
  const [telemetry, authority, confusion, coverage, llmMentions, experience, journey, updates] = await Promise.all([
    buildTelemetry(input),
    buildAuthority(input),
    buildConfusion(input),
    buildCoverage(input).catch(() => null),
    buildLlmMentionsOverview({
      siteId,
      days: spanDays,
      windowStart: start,
      windowEnd: end,
      sources: ['chat_gpt', 'google_ai_overviews'],
    }).catch(() => null),
    buildExperience(input).catch(() => null),
    buildJourney(input).catch(() => null),
    sql`
      SELECT from_version, to_version, applied_at, created_at
      FROM update_history
      WHERE site_id = ${siteId}::uuid
        AND created_at >= ${start}
        AND created_at <= ${end}
      ORDER BY created_at DESC
      LIMIT 10
    `.catch(() => []),
  ]);

  const authorityScore = authority?.authorityScore || 0;
  const confusionTotal = Object.values(confusion?.totals || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const coverageGaps = asArray(coverage?.gaps);
  const blockers = asArray(authority?.blockers);

  const readinessSignal =
    authorityScore >= 70 && confusionTotal < 10 && coverageGaps.length < 3
      ? 'Momentum is improving, with a few journey gaps still to address'
      : authorityScore >= 50
        ? 'Core performance is improving, but visitor journey clarity needs work'
        : 'Several blockers are limiting progress and should be addressed first';

  const technicalStatus = authorityScore >= 70 ? 'Improving' : authorityScore < 50 ? 'Constrained' : 'Stable';
  const technicalBlockers = blockers.slice(0, 3);
  const technicalReadiness = {
    status: technicalStatus,
    pagePerformanceTrends: 'No major change this period',
    crawlIndexNotes: 'Visibility assessment pending',
    outstandingBlockers: technicalBlockers,
    framing: authorityScore >= 70 ? 'Foundation is strengthening' : authorityScore < 50 ? 'Foundation issues are emerging' : 'Foundation is currently steady',
    plainLanguage: technicalPlainLanguage(technicalStatus, technicalBlockers),
  };

  const conversionStatus = confusionTotal > 10 ? 'Fragmented' : confusionTotal > 0 ? 'Partially Coherent' : 'Clarifying';
  const conversionFriction = confusionTotal > 0 ? 'Visitor journey friction is present in recent signals' : 'No major journey friction is visible yet';
  const conversionArchitecture = {
    status: conversionStatus,
    primaryFrictionPoint: conversionFriction,
    improvementsSinceLastPeriod: [],
    framing: 'User journey clarity is being assessed from cached behavioral signals',
    plainLanguage: conversionPlainLanguage(conversionStatus, conversionFriction, []),
  };

  const highProofGaps = coverageGaps.filter((gap) => gap?.severity === 'high' || gap?.severity === 'critical');
  const contentStatus = coverageGaps.length === 0 ? 'Strengthening' : coverageGaps.length > 5 ? 'Weak' : 'Uneven';
  const proofGapLabels = highProofGaps.map((gap) => gap.label || 'Proof gap').slice(0, 3);
  const contentSignalQuality = {
    status: contentStatus,
    authoritySignalDensity: authorityScore >= 70 ? 'Strong' : authorityScore > 0 ? 'Moderate' : 'Pending',
    intentAlignmentNotes: coverage?.missingIntents?.length ? 'Missing intent coverage is present' : 'No major missing intents flagged',
    proofGaps: proofGapLabels,
    framing: 'Trust signals are improving but still need consistency',
    plainLanguage: contentPlainLanguage(contentStatus, proofGapLabels),
  };

  const growthStatus = authorityScore >= 70 && confusionTotal < 10 ? 'Suitable' : authorityScore < 50 || blockers.length > 3 ? 'Not Ready' : 'Cautious';
  const growthMeasurement = telemetry?.totals?.pageViews > 0;
  const growthConstraints = blockers.slice(0, 2);
  const growthReadiness = {
    status: growthStatus,
    paidAmplificationSuitability: 'Directional assessment only',
    measurementHooksPresent: growthMeasurement,
    scalabilityConstraints: growthConstraints,
    framing: 'Growth potential is improving, but expectations should stay realistic',
    plainLanguage: growthPlainLanguage(growthStatus, growthConstraints, growthMeasurement),
  };

  const constraintRegister = [
    ...blockers.map((blocker) => ({ status: 'Active', constraint: blocker, type: 'Technical' })),
    ...highProofGaps.map((gap) => ({ status: 'Emerging', constraint: gap.label || 'Proof density gap', type: 'Messaging' })),
  ].slice(0, 8);

  const changeLog = updates.length > 0
    ? updates.map((update) => ({
        change: `Config updated from ${update.from_version} to ${update.to_version}`,
        timestamp: (update.applied_at || update.created_at || new Date()).toISOString(),
        status: update.applied_at ? 'applied' : 'pending',
      }))
    : [{ change: 'No config changes in this period - optimisation continues at current depth', timestamp: new Date().toISOString(), status: 'applied' }];

  const trafficTrend = trendSymbol(telemetry?.trend?.visits || 0);
  const directionalSignals = telemetry?.totals?.pageViews > 0
    ? {
        trafficTrend,
        engagementNotes: `Traffic patterns show ${trafficTrend === '↑' ? 'increasing' : trafficTrend === '↓' ? 'decreasing' : 'stable'} activity`,
        funnelProgressionSignals: 'High-level funnel assessment pending',
        disclaimer: 'Signals are directional only and cannot be attributed to GPTO in isolation.',
      }
    : null;

  const nextLogicalFocus = constraintRegister.some((item) => item.type === 'Technical')
    ? 'Address the top blocker before pushing growth'
    : constraintRegister.length > 5
      ? 'Stabilise key areas before expanding campaigns'
      : 'Continue improving the current foundation';

  return {
    site: { id: site.id, domain: site.domain, tier: 'GOLD' },
    period: { start: start.toISOString(), end: end.toISOString() },
    executiveSignalBar: {
      tier: 'GOLD',
      assessmentScope: 'Website visibility, trust, and growth readiness',
      period: `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`,
      readinessSignal,
    },
    optimisationAxes: { technicalReadiness, conversionArchitecture, contentSignalQuality, growthReadiness },
    constraintRegister,
    changeLog,
    directionalSignals,
    riskExpectationControl: [
      'Increasing spend too early can magnify existing weaknesses',
      'Trust and content improvements usually require consistent effort over time',
      'Insights guide decisions, but they do not guarantee specific business outcomes',
    ],
    nextLogicalFocus,
    aiVisibility: llmMentions?.aiVisibility || null,
    customerInsights: buildCustomerInsights({
      telemetry,
      authority,
      confusion,
      coverage,
      experience,
      journey,
      llmMentions,
      technicalReadiness,
      conversionArchitecture,
      contentSignalQuality,
      growthReadiness,
      constraintRegister,
      changeLog,
      nextLogicalFocus,
    }),
  };
}

function technicalPlainLanguage(status, blockers) {
  const statusLine =
    status === 'Improving'
      ? 'The site foundation is getting stronger, and fixes are landing.'
      : status === 'Constrained'
        ? 'The site foundation is under strain, which limits progress.'
        : 'The site foundation is steady, with no major changes.';
  const blockerLine = blockers.length > 0
    ? `There ${blockers.length === 1 ? 'is' : 'are'} ${blockers.length} issue${blockers.length === 1 ? '' : 's'} still slowing momentum.`
    : 'No major blockers are called out right now.';
  return `${statusLine} ${blockerLine}`;
}

function conversionPlainLanguage(status, friction, improvements) {
  const statusLine =
    status === 'Clarifying'
      ? 'The customer journey is becoming clearer, but it is not fully tightened yet.'
      : status === 'Fragmented'
        ? 'The customer journey feels disjointed, which causes drop-off.'
        : 'Parts of the customer journey work, but it is inconsistent.';
  const frictionLine = friction ? `Main customer blocker: ${friction}.` : 'Main customer blocker is not specified.';
  const improvementLine = improvements.length > 0
    ? `${improvements.length} improvement${improvements.length === 1 ? '' : 's'} were implemented recently.`
    : 'No recent improvements were recorded this period.';
  return `${statusLine} ${frictionLine} ${improvementLine}`;
}

function contentPlainLanguage(status, proofGaps) {
  const statusLine =
    status === 'Strengthening'
      ? 'Content credibility is improving and aligning better with what people expect.'
      : status === 'Weak'
        ? 'Content does not yet build enough trust or match intent.'
        : 'Some content performs well, but consistency is missing.';
  const proofLine = proofGaps.length > 0
    ? `There ${proofGaps.length === 1 ? 'is' : 'are'} ${proofGaps.length} trust gap${proofGaps.length === 1 ? '' : 's'} to address.`
    : 'No major trust gaps were flagged this period.';
  return `${statusLine} ${proofLine}`;
}

function growthPlainLanguage(status, constraints, tracking) {
  const statusLine =
    status === 'Suitable'
      ? 'The foundation can support growth without major waste.'
      : status === 'Not Ready'
        ? 'Scaling now would likely underperform without fixes first.'
        : 'Growth is possible, but it needs careful pacing.';
  const trackingLine = tracking
    ? 'Tracking is in place to measure outcomes.'
    : 'Tracking is missing, so results will be hard to measure.';
  const constraintLine = constraints.length > 0
    ? `${constraints.length} scale limit${constraints.length === 1 ? '' : 's'} still need attention.`
    : 'No major scale limits were flagged this period.';
  return `${statusLine} ${trackingLine} ${constraintLine}`;
}

export async function buildDashboardStats(input) {
  const telemetry = await buildTelemetry(input);
  return {
    sites: input?.siteId ? 1 : 0,
    siteId: input?.siteId || null,
    range: telemetry.range,
    totals: telemetry.totals,
    trend: telemetry.trend,
    topPages: telemetry.topPages,
    generatedAt: new Date().toISOString(),
  };
}
