export const COMPETITOR_SCORE_MODEL_VERSION = 'gpto.competitor_visibility.v1';

function num(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function nullableNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

export function normalizeCompetitorDomain(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/:\d+$/, '');
}

function fallbackSourceScore(source = {}) {
  const mentions = num(source.mentions);
  const citations = num(source.citations);
  const citedPages = num(source.citedPages);
  const aiSearchVolume = num(source.aiSearchVolume);
  const shareOfVoice = nullableNum(source.shareOfVoice);
  const citationRate = mentions > 0 ? (citations / Math.max(1, mentions)) * 100 : 0;
  const reach = Math.min(100, Math.log10(mentions + 1) * 18);
  const audience = Math.min(100, Math.log10(aiSearchVolume + 1) * 16);
  const citedPageScore = Math.min(100, Math.log10(citedPages + 1) * 28);
  return clampScore(average([reach, audience, citedPageScore, citationRate, shareOfVoice === null ? null : shareOfVoice * 100]) ?? 0);
}

function technicalReadiness(serverChecks = null) {
  if (!serverChecks || Object.keys(serverChecks).length === 0) return null;
  let score = 100;
  const homepageStatus = nullableNum(serverChecks.homepageStatus);
  const robotsStatus = nullableNum(serverChecks.robotsStatus);
  const sitemapStatus = nullableNum(serverChecks.sitemapStatus);
  if (homepageStatus && homepageStatus >= 400) score -= 35;
  if (robotsStatus && robotsStatus >= 400) score -= 12;
  if (sitemapStatus && sitemapStatus >= 400) score -= 14;
  if (serverChecks.homepageCanonicalMatches === false) score -= 18;
  if (Array.isArray(serverChecks.aiBotsBlocked) && serverChecks.aiBotsBlocked.length > 0) score -= 25;
  if (serverChecks.llmsTxtPresent === false) score -= 4;
  return clampScore(score);
}

function contentReadiness(crawl = null) {
  if (!crawl) return null;
  const wordScore = Math.min(100, Math.max(0, num(crawl.wordCount) / 12));
  const headingScore = Math.min(100, num(crawl.headingCount) * 14);
  const linkScore = Math.min(100, num(crawl.linkCount) * 3);
  const titleScore = crawl.title ? 85 : 20;
  const descriptionScore = crawl.description ? 85 : 25;
  return clampScore(average([wordScore, headingScore, linkScore, titleScore, descriptionScore]) ?? 0);
}

function schemaReadiness(crawl = null) {
  if (!crawl) return null;
  return clampScore(Math.min(100, (crawl.schemaTypes?.length || 0) * 25));
}

function publicBenchmarkEstimates({ crawl = null, serverChecks = null, technicalScore = null, contentScore = null, schemaScore = null }) {
  const sitemapUrlCount = num(serverChecks?.sitemapUrlCount);
  const wordCount = num(crawl?.wordCount);
  const headingCount = num(crawl?.headingCount);
  const linkCount = num(crawl?.linkCount);
  const schemaCount = crawl?.schemaTypes?.length || 0;
  const footprintScore = clampScore(average([
    Math.min(100, Math.log10(sitemapUrlCount + 1) * 25),
    Math.min(100, Math.log10(wordCount + 1) * 18),
    Math.min(100, linkCount * 2),
    Math.min(100, schemaCount * 18),
  ]) ?? 0);
  const aiVisibility = clampScore(average([technicalScore, contentScore, schemaScore, footprintScore]) ?? 0);
  const audience = Math.max(0, Math.round(
    (sitemapUrlCount * 220) +
    (wordCount * 18) +
    (headingCount * 120) +
    (linkCount * 90) +
    (schemaCount * 850)
  ));
  const mentions = Math.max(1, Math.round(
    num(crawl?.brandMentions) +
    (crawl?.title ? 4 : 0) +
    (crawl?.description ? 6 : 0) +
    (schemaCount * 3) +
    Math.log10(wordCount + 1) * 5
  ));
  const citations = Math.max(0, Math.round(
    (sitemapUrlCount > 0 ? Math.log10(sitemapUrlCount + 1) * 6 : 0) +
    (schemaCount * 2) +
    (linkCount > 0 ? Math.log10(linkCount + 1) * 4 : 0)
  ));
  const citedPages = Math.max(1, Math.round(Math.min(250, Math.max(schemaCount, Math.log10(sitemapUrlCount + 1) * 12))));
  return { aiVisibility, audience, mentions, citations, citedPages, footprintScore };
}

function buildIssues({ externalComplete, trafficComplete, crawlComplete, technicalScore, contentScore, schemaScore }) {
  const issues = [];
  const add = (label, count, severity) => {
    if (count > 0) issues.push({ label, count, severity, pages: [] });
  };
  if (!externalComplete) add('External AI visibility data missing', 1, 'high');
  if (!trafficComplete) add('Website audience provider missing', 1, 'low');
  if (!crawlComplete) add('Public crawl data missing', 1, 'medium');
  if (technicalScore !== null && technicalScore < 70) add('Technical readiness issue', Math.max(1, Math.round((70 - technicalScore) / 12)), 'high');
  if (contentScore !== null && contentScore < 70) add('Content readiness issue', Math.max(1, Math.round((70 - contentScore) / 12)), 'medium');
  if (schemaScore !== null && schemaScore < 70) add('Schema readiness issue', Math.max(1, Math.round((70 - schemaScore) / 12)), 'medium');
  return issues;
}

export function computeCompetitorScoreSnapshot(input = {}) {
  const llmSources = input.llmSources || [];
  const sourceScores = {};
  for (const source of llmSources) {
    if (!source.source) continue;
    sourceScores[source.source] = clampScore(source.score ?? fallbackSourceScore(source));
  }

  const mentionsTotal = llmSources.reduce((sum, source) => sum + num(source.mentions), 0);
  const citationsTotal = llmSources.reduce((sum, source) => sum + num(source.citations), 0);
  const citedPagesTotal = llmSources.reduce((sum, source) => sum + num(source.citedPages), 0);
  const aiAudienceTotal = llmSources.reduce((sum, source) => sum + num(source.aiSearchVolume) + Math.round(num(source.impressions) * 0.1), 0);
  const shareOfVoice = average(llmSources.map((source) => nullableNum(source.shareOfVoice)));
  const technicalScore = technicalReadiness(input.serverChecks);
  const contentScore = contentReadiness(input.crawl);
  const schemaScore = schemaReadiness(input.crawl);
  const authorityProxy = clampScore(average([
    Math.min(100, Math.log10(citationsTotal + 1) * 24),
    Math.min(100, Math.log10(citedPagesTotal + 1) * 28),
    shareOfVoice === null ? null : shareOfVoice * 100,
  ]) ?? 0);
  const externalComplete = llmSources.some((source) => num(source.mentions) > 0 || num(source.citations) > 0 || nullableNum(source.score) !== null);
  const trafficComplete = nullableNum(input.websiteAudience) !== null;
  const crawlComplete = Boolean(input.crawl);
  const publicEstimates = publicBenchmarkEstimates({ crawl: input.crawl, serverChecks: input.serverChecks, technicalScore, contentScore, schemaScore });
  const hasPublicEstimate = !externalComplete && (crawlComplete || technicalScore !== null);
  const mentions = externalComplete ? mentionsTotal : hasPublicEstimate ? publicEstimates.mentions : null;
  const citations = externalComplete ? citationsTotal : hasPublicEstimate ? publicEstimates.citations : null;
  const citedPages = externalComplete ? citedPagesTotal : hasPublicEstimate ? publicEstimates.citedPages : null;
  const aiAudience = externalComplete ? aiAudienceTotal : hasPublicEstimate ? publicEstimates.audience : null;
  const missingData = { dataForSeo: !externalComplete, websiteAudience: !trafficComplete, crawl: !crawlComplete, publicEstimate: hasPublicEstimate };
  const status = !externalComplete
    ? 'partial_external_missing'
    : !crawlComplete
      ? 'partial_crawl_missing'
      : !trafficComplete
        ? 'partial_traffic_missing'
        : 'complete';
  const internalProxy = clampScore(average([technicalScore, contentScore, schemaScore, authorityProxy]) ?? 0);
  if (!externalComplete) sourceScores.internal_readiness = internalProxy;
  if (hasPublicEstimate) sourceScores.public_estimate = publicEstimates.aiVisibility;
  const aiVisibility = externalComplete ? clampScore(average(Object.values(sourceScores)) ?? 0) : hasPublicEstimate ? publicEstimates.aiVisibility : null;
  const dataMode = externalComplete ? 'external' : 'public_estimate';

  return {
    modelVersion: COMPETITOR_SCORE_MODEL_VERSION,
    scores: {
      aiVisibility,
      chatGpt: sourceScores.chat_gpt ?? null,
      googleAiOverviews: sourceScores.google_ai_overviews ?? null,
      aiAudience,
      websiteAudience: nullableNum(input.websiteAudience),
      mentions,
      citations,
      citedPages,
      shareOfVoice: shareOfVoice === null ? null : Number((shareOfVoice * 100).toFixed(1)),
      authorityProxy,
      internalReadiness: internalProxy,
      publicFootprint: hasPublicEstimate ? publicEstimates.footprintScore : null,
      contentReadiness: contentScore,
      technicalReadiness: technicalScore,
      schemaReadiness: schemaScore,
    },
    metrics: {
      aiAudience,
      websiteAudience: nullableNum(input.websiteAudience),
      mentions,
      citations,
      citedPages,
      shareOfVoice: shareOfVoice === null ? null : Number((shareOfVoice * 100).toFixed(1)),
    },
    sourceScores,
    issueDistribution: buildIssues({ externalComplete, trafficComplete, crawlComplete, technicalScore, contentScore, schemaScore }),
    evidence: {
      generatedAt: input.generatedAt || new Date().toISOString(),
      domain: normalizeCompetitorDomain(input.domain),
      displayName: input.displayName || normalizeCompetitorDomain(input.domain),
      llmSources,
      serverChecks: input.serverChecks || null,
      crawl: input.crawl || null,
      topCitedPages: input.topCitedPages || [],
      topPrompts: input.topPrompts || [],
      sourceGaps: input.sourceGaps || [],
      dataCompleteness: { status, externalVisibilityComplete: externalComplete, dataMode, publicEstimate: hasPublicEstimate, missing: missingData },
    },
    freshness: {
      generatedAt: input.generatedAt || new Date().toISOString(),
      modelVersion: COMPETITOR_SCORE_MODEL_VERSION,
    },
    missingData,
    dataMode,
    status,
  };
}
