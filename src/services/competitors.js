import { assertSiteAccess, getUserContext } from '../access.js';
import { db } from '../db.js';
import { ok, parsePositiveInt, requireSiteId } from '../contracts.js';

const METRIC_KEYS = new Set(['aiVisibility', 'audience', 'mentions', 'citations', 'citedPages', 'shareOfVoice', 'technicalReadiness', 'contentReadiness']);
const RANGE_KEYS = new Set(['7d', '30d', '90d']);
const COLORS = ['indigo', 'emerald', 'violet', 'amber', 'rose'];

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nullableNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function num(value, fallback = 0) {
  const parsed = nullableNum(value);
  return parsed === null ? fallback : parsed;
}

function average(values = []) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function clampScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function resolveWindow(rangeKey, now = new Date()) {
  const end = new Date(now);
  const start = new Date(end);
  start.setDate(end.getDate() - (rangeKey === '90d' ? 90 : rangeKey === '30d' ? 30 : 7));
  return { start, end };
}

function metricFromSite(row, metric) {
  const scores = asRecord(row?.scores);
  const evidence = asRecord(row?.evidence);
  const scoringInputs = asRecord(evidence.scoringInputs);
  const llmSources = asArray(scoringInputs.llmSources);
  if (metric === 'aiVisibility') return nullableNum(scores.overallAiVisibility);
  if (metric === 'mentions') return nullableNum(scores.mentions) ?? nullableNum(asRecord(evidence.external).mentions);
  if (metric === 'citations') return nullableNum(scores.citations) ?? nullableNum(asRecord(evidence.external).citations);
  if (metric === 'citedPages') return nullableNum(scores.citedPages) ?? nullableNum(asRecord(evidence.external).citedPages);
  if (metric === 'audience') {
    const audience = llmSources.reduce((sum, source) => sum + num(source.aiSearchVolume) + Math.round(num(source.impressions) * 0.1), 0);
    return audience || nullableNum(asRecord(evidence.external).aiSearchVolume) || nullableNum(asRecord(evidence.external).impressions);
  }
  if (metric === 'technicalReadiness') return nullableNum(asRecord(evidence.readiness).technicalHealthScore) ?? nullableNum(scores.visitorExperience);
  if (metric === 'contentReadiness') {
    const contentIssues = nullableNum(scores.contentIssues);
    return nullableNum(scoringInputs.coverageConfidence) ?? nullableNum(scores.contentReadiness) ?? (contentIssues === null ? null : clampScore(100 - contentIssues));
  }
  return null;
}

function buildPrimaryScores(scoresValue, evidenceValue) {
  const scores = asRecord(scoresValue);
  const evidence = asRecord(evidenceValue);
  const external = asRecord(evidence.external);
  const scoringInputs = asRecord(evidence.scoringInputs);
  const readiness = asRecord(evidence.readiness);
  const llmSources = asArray(scoringInputs.llmSources);
  const llmAudience = llmSources.reduce((sum, source) => sum + num(source.aiSearchVolume) + Math.round(num(source.impressions) * 0.1), 0);
  const aiVisibility = nullableNum(scores.overallAiVisibility) ?? nullableNum(scores.aiVisibility) ?? 0;
  const visitorExperience = nullableNum(scores.visitorExperience);
  const authority = nullableNum(scores.authority) ?? nullableNum(scores.siteAuthority);
  const contentIssues = nullableNum(scores.contentIssues);
  const technicalReadiness = nullableNum(readiness.technicalHealthScore) ?? visitorExperience ?? clampScore(average([aiVisibility, authority]) ?? aiVisibility);
  const contentReadiness = nullableNum(scoringInputs.coverageConfidence) ?? nullableNum(scores.contentReadiness) ?? (contentIssues === null ? clampScore(average([aiVisibility, visitorExperience, authority]) ?? aiVisibility) : clampScore(100 - contentIssues));
  const mentions = nullableNum(scores.mentions) ?? nullableNum(external.mentions) ?? Math.max(1, Math.round(aiVisibility * 4 + (authority ?? 0) * 2));
  const citations = nullableNum(scores.citations) ?? nullableNum(external.citations) ?? Math.max(0, Math.round(mentions * 0.38));
  const citedPages = nullableNum(scores.citedPages) ?? nullableNum(external.citedPages) ?? Math.max(1, Math.round(citations * 0.65));
  const aiAudience = llmAudience || nullableNum(external.aiSearchVolume) || nullableNum(external.impressions) || Math.max(1, Math.round(mentions * 180 + aiVisibility * 750));
  return {
    ...scores,
    aiVisibility,
    overallAiVisibility: aiVisibility,
    aiAudience,
    mentions,
    citations,
    citedPages,
    technicalReadiness,
    contentReadiness,
    authorityProxy: authority ?? aiVisibility,
  };
}

function metricFromCompetitor(row, metric) {
  const scores = asRecord(row?.scores);
  const metrics = asRecord(row?.metrics);
  const missingData = asRecord(row?.missing_data);
  const externalMetric = metric === 'aiVisibility' || metric === 'audience' || metric === 'mentions' || metric === 'citations' || metric === 'citedPages' || metric === 'shareOfVoice';
  if (externalMetric && missingData.dataForSeo && !missingData.publicEstimate) return null;
  if (metric === 'aiVisibility') return nullableNum(scores.aiVisibility);
  if (metric === 'audience') return nullableNum(metrics.aiAudience) ?? nullableNum(scores.aiAudience);
  if (metric === 'mentions') return nullableNum(metrics.mentions) ?? nullableNum(scores.mentions);
  if (metric === 'citations') return nullableNum(metrics.citations) ?? nullableNum(scores.citations);
  if (metric === 'citedPages') return nullableNum(metrics.citedPages) ?? nullableNum(scores.citedPages);
  if (metric === 'shareOfVoice') return nullableNum(metrics.shareOfVoice) ?? nullableNum(scores.shareOfVoice);
  if (metric === 'technicalReadiness') return nullableNum(scores.technicalReadiness);
  if (metric === 'contentReadiness') return nullableNum(scores.contentReadiness);
  return null;
}

function buildChange(points) {
  const clean = points.filter((point) => typeof point.value === 'number');
  if (clean.length < 2) return null;
  const first = clean[0].value;
  const last = clean[clean.length - 1].value;
  if (first === 0) return last === 0 ? 0 : 100;
  return Number((((last - first) / Math.abs(first)) * 100).toFixed(1));
}

async function assertCompetitorAccess(request, siteId) {
  const portalScope = request.url.searchParams.get('portal') || 'employee';
  await assertSiteAccess({ siteId, portalScope, user: getUserContext(request) });
}

export async function buildCompetitorScorecards({ siteId, rangeKey = '30d', metric = 'aiVisibility' }) {
  const sql = db();
  const { start, end } = resolveWindow(rangeKey);
  const [site] = await sql`SELECT id, domain FROM sites WHERE id = ${siteId}::uuid LIMIT 1`;
  if (!site) {
    const error = new Error('Site not found');
    error.statusCode = 404;
    throw error;
  }

  const [primaryLatest] = await sql`
    SELECT *
    FROM site_score_snapshots
    WHERE site_id = ${siteId}::uuid AND range_key = ${rangeKey}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const competitorRows = await sql`
    SELECT *
    FROM competitors
    WHERE site_id = ${siteId}::uuid AND status <> 'paused'
    ORDER BY created_at ASC
    LIMIT 4
  `;
  const competitorLatest = [];
  for (const competitor of competitorRows) {
    const [snapshot] = await sql`
      SELECT *
      FROM competitor_score_snapshots
      WHERE site_id = ${siteId}::uuid AND competitor_id = ${competitor.id}::uuid AND range_key = ${rangeKey}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    competitorLatest.push({ competitor, snapshot });
  }

  const primaryHistory = await sql`
    SELECT *
    FROM site_score_snapshots
    WHERE site_id = ${siteId}::uuid AND range_key = ${rangeKey} AND day >= ${start} AND day <= ${end}
    ORDER BY day ASC
  `;
  const competitorHistory = await sql`
    SELECT *
    FROM competitor_score_snapshots
    WHERE site_id = ${siteId}::uuid AND range_key = ${rangeKey} AND day >= ${start} AND day <= ${end}
    ORDER BY day ASC
  `;

  const primaryPoints = primaryHistory.map((row) => ({ date: row.day?.toISOString?.().slice(0, 10), value: metricFromSite(row, metric) }));
  const series = [
    { id: site.id, domain: site.domain, label: 'You', colorKey: COLORS[0], points: primaryPoints, changePct: buildChange(primaryPoints) },
    ...competitorRows.map((competitor, index) => {
      const rows = competitorHistory.filter((row) => String(row.competitor_id) === String(competitor.id));
      const points = rows.map((row) => ({ date: row.day?.toISOString?.().slice(0, 10), value: metricFromCompetitor(row, metric) }));
      return {
        id: competitor.id,
        domain: competitor.domain,
        label: competitor.name || competitor.domain,
        colorKey: competitor.color_key || COLORS[index + 1] || 'slate',
        points,
        changePct: buildChange(points),
      };
    }),
  ];

  const entities = [
    {
      id: site.id,
      domain: site.domain,
      label: 'You',
      colorKey: COLORS[0],
      isPrimary: true,
      scores: buildPrimaryScores(primaryLatest?.scores, primaryLatest?.evidence),
      metrics: {},
      issueDistribution: asArray(primaryLatest?.issue_distribution),
      evidence: asRecord(primaryLatest?.evidence),
      freshness: asRecord(primaryLatest?.evidence).freshness || {},
      missingData: asRecord(asRecord(primaryLatest?.evidence).dataCompleteness).missing || {},
      generatedAt: primaryLatest?.created_at?.toISOString?.() || null,
    },
    ...competitorLatest.map(({ competitor, snapshot }, index) => ({
      id: snapshot?.id || competitor.id,
      competitorId: competitor.id,
      domain: competitor.domain,
      label: competitor.name || competitor.domain,
      colorKey: competitor.color_key || COLORS[index + 1] || 'slate',
      isPrimary: false,
      scores: asRecord(snapshot?.scores),
      metrics: asRecord(snapshot?.metrics),
      issueDistribution: asArray(snapshot?.issue_distribution),
      evidence: asRecord(snapshot?.evidence),
      freshness: asRecord(snapshot?.freshness),
      missingData: asRecord(snapshot?.missing_data),
      generatedAt: snapshot?.created_at?.toISOString?.() || null,
    })),
  ];
  entities[0].metrics.aiAudience = nullableNum(entities[0].scores.aiAudience);
  entities[0].metrics.mentions = nullableNum(entities[0].scores.mentions);
  entities[0].metrics.citations = nullableNum(entities[0].scores.citations);
  entities[0].metrics.citedPages = nullableNum(entities[0].scores.citedPages);
  const shareBasis = entities.map((entity) => ({
    entity,
    value: nullableNum(entity.scores.aiVisibility) ?? nullableNum(entity.scores.overallAiVisibility) ?? 0,
  }));
  const shareTotal = shareBasis.reduce((sum, item) => sum + item.value, 0);
  for (const item of shareBasis) {
    const fallbackShare = shareTotal > 0 ? (item.value / shareTotal) * 100 : 100 / Math.max(1, shareBasis.length);
    if (nullableNum(item.entity.scores.shareOfVoice) === null) {
      item.entity.scores.shareOfVoice = Number(fallbackShare.toFixed(1));
    }
    if (nullableNum(item.entity.metrics.shareOfVoice) === null) {
      item.entity.metrics.shareOfVoice = item.entity.scores.shareOfVoice;
    }
  }
  const primaryMetricFallback = metricFromCompetitor({ scores: entities[0].scores, metrics: entities[0].metrics, missing_data: entities[0].missingData }, metric);
  if (!primaryPoints.length && primaryMetricFallback !== null) {
    primaryPoints.push({ date: new Date().toISOString().slice(0, 10), value: primaryMetricFallback });
  } else {
    for (const point of primaryPoints) {
      if (point.value === null) point.value = primaryMetricFallback;
    }
  }

  const gaps = competitorLatest.flatMap(({ competitor, snapshot }) => {
    const evidence = asRecord(snapshot?.evidence);
    const sourceGaps = asArray(evidence.sourceGaps);
    const issueRows = asArray(snapshot?.issue_distribution);
    return [
      ...asArray(evidence.topPrompts).slice(0, 5).map((prompt) => ({
        type: 'prompt',
        competitor: competitor.domain,
        label: String(prompt.question || prompt.label || 'Prompt opportunity'),
        metric: nullableNum(prompt.aiSearchVolume) ?? nullableNum(prompt.impressions),
        recommendation: `Create or improve a direct answer for this prompt where ${competitor.domain} is visible.`,
      })),
      ...asArray(evidence.topCitedPages).slice(0, 5).map((page) => ({
        type: 'cited_page',
        competitor: competitor.domain,
        label: String(page.url || page.page || 'Cited page'),
        metric: nullableNum(page.mentions) ?? nullableNum(page.aiSearchVolume),
        recommendation: `Review why this competitor page is cited and build stronger equivalent proof on your site.`,
      })),
      ...sourceGaps.slice(0, 5).map((gap) => ({
        type: String(gap.type || 'readiness_gap'),
        competitor: competitor.domain,
        label: String(gap.label || 'Competitor readiness gap'),
        metric: null,
        recommendation: 'Use this public competitor signal to improve your own crawlability, structure, or answer readiness.',
      })),
      ...issueRows.slice(0, 5).map((issue) => ({
        type: 'technical_content_issue',
        competitor: competitor.domain,
        label: String(issue.label || 'Competitor issue'),
        metric: nullableNum(issue.count),
        recommendation: `Track this issue while comparing ${competitor.domain} against your own readiness scores.`,
      })),
    ];
  }).slice(0, 20);

  return {
    siteId,
    siteDomain: site.domain,
    rangeKey,
    metric,
    entities,
    series,
    tabs: [
      { key: 'aiVisibility', label: 'AI Visibility', description: 'AI visibility score from external data when available, otherwise a public readiness estimate.' },
      { key: 'audience', label: 'Audience', description: 'Estimated audience proxy from public content footprint when paid traffic data is unavailable.' },
      { key: 'mentions', label: 'Mentions', description: 'External AI mentions when available, otherwise a public brand-footprint signal.' },
      { key: 'citations', label: 'Citations', description: 'External AI citations when available, otherwise a public citation-readiness signal.' },
      { key: 'citedPages', label: 'Cited Pages', description: 'External cited pages when available, otherwise estimated citeable page footprint.' },
      { key: 'shareOfVoice', label: 'Share of Voice', description: 'Visibility share versus competitors based on available or estimated scores.' },
      { key: 'technicalReadiness', label: 'Technical Readiness', description: 'Robots, sitemap, canonical, and crawler access checks.' },
      { key: 'contentReadiness', label: 'Content Gaps', description: 'Public content structure and extraction readiness.' },
    ],
    gaps: {
      rows: gaps,
      opportunities: {
        defend: gaps.filter((row) => row.type === 'cited_page').slice(0, 5),
        optimize: gaps.filter((row) => row.type === 'prompt' || row.type === 'content_gap' || row.type === 'schema_gap').slice(0, 5),
        create: gaps.filter((row) => row.type === 'prompt').slice(5, 10),
        monitor: entities.filter((entity) => !entity.isPrimary && entity.missingData?.dataForSeo),
      },
    },
    freshness: {
      generatedAt: new Date().toISOString(),
      primaryGeneratedAt: primaryLatest?.created_at?.toISOString?.() || null,
    },
  };
}

export async function readCompetitorScorecards(request) {
  const siteId = requireSiteId(request.url.searchParams);
  await assertCompetitorAccess(request, siteId);
  const range = request.url.searchParams.get('range') || '30d';
  const metric = request.url.searchParams.get('metric') || 'aiVisibility';
  return ok(await buildCompetitorScorecards({
    siteId,
    rangeKey: RANGE_KEYS.has(range) ? range : '30d',
    metric: METRIC_KEYS.has(metric) ? metric : 'aiVisibility',
  }));
}

export async function readCompetitorTrends(request) {
  return readCompetitorScorecards(request);
}

export async function readCompetitorGaps(request) {
  const body = await readCompetitorScorecards(request);
  return ok({
    siteId: body.body.siteId,
    rangeKey: body.body.rangeKey,
    gaps: body.body.gaps,
    freshness: body.body.freshness,
  });
}
