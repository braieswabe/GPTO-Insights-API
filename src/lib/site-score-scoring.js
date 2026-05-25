export const SITE_SCORE_MODEL_VERSION = 'gpto.visibility.v1';

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
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function average(values) {
  const clean = (values || []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function fallbackSourceScore(source) {
  const citationRate = source.mentions > 0 ? (num(source.citations) / Math.max(1, source.mentions)) * 100 : 0;
  const reach = Math.min(100, Math.log10(num(source.mentions) + 1) * 18);
  const demand = Math.min(100, Math.log10(num(source.aiSearchVolume) + 1) * 16);
  return clampScore(reach * 0.35 + demand * 0.25 + citationRate * 0.4);
}

function coverageBand(confidence, issues) {
  if (typeof confidence === 'number' && confidence >= 80) return 'High';
  if (issues === 0 && confidence > 0) return 'High';
  if (typeof confidence === 'number' && confidence >= 50) return 'Medium';
  if (issues > 0) return 'Low';
  return 'Unknown';
}

function summarizeIssueDistribution(gaps = []) {
  const grouped = new Map();
  for (const gap of gaps) {
    const label = String(gap?.label || gap?.name || 'Content issue').trim();
    const severity = String(gap?.severity || 'medium').trim().toLowerCase();
    const key = `${label}::${severity}`;
    const current = grouped.get(key) || { label, count: 0, severity, pages: new Set() };
    current.count += Math.max(1, Math.round(num(gap?.count, 1)));
    for (const page of asArray(gap?.pages)) {
      if (typeof page === 'string' && page.trim()) current.pages.add(page.trim());
    }
    grouped.set(key, current);
  }
  return Array.from(grouped.values())
    .map((item) => ({ label: item.label, count: item.count, severity: item.severity, pages: Array.from(item.pages).slice(0, 10) }))
    .sort((a, b) => b.count - a.count);
}

function scoreToIssueCount(score, maxCount) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score >= 70) return 0;
  return Math.max(1, Math.round(((70 - score) / 70) * maxCount));
}

function buildDerivedIssues(input = {}) {
  const issues = [];
  const add = (label, count, severity, pages = []) => {
    if (count <= 0) return;
    issues.push({ label, count, severity, pages });
  };
  add('Indexability readiness issue', scoreToIssueCount(input.indexabilityScore, 8), 'high');
  add('Content extractability issue', scoreToIssueCount(input.extractabilityScore, 10), 'medium');
  add('Trust proof density issue', scoreToIssueCount(input.trustProofDensityScore, 8), 'medium');
  add('Internal linking issue', scoreToIssueCount(input.internalLinkDensityScore, 6), 'medium');
  add('CTA clarity issue', scoreToIssueCount(input.ctaClarityScore, 6), 'medium');
  add('Structured data coverage issue', scoreToIssueCount(input.schemaTemplateCoverageScore, 8), 'high');
  add('Canonical consistency issue', scoreToIssueCount(input.canonicalHealthScore, 6), 'high');
  add('Image accessibility issue', scoreToIssueCount(input.imageAltCoverageScore, 5), 'low');
  add('Content depth issue', scoreToIssueCount(input.textDepthScore, 6), 'medium');
  add('Heading structure issue', scoreToIssueCount(input.headingStructureScore, 6), 'medium');
  add('Engagement quality issue', scoreToIssueCount(input.engagementQualityScore, 6), 'medium');
  add('Technical health issue', scoreToIssueCount(input.technicalHealthScore, 8), 'high');

  const serverChecks = input.serverChecks || {};
  if (nullableNum(serverChecks.homepageStatus) && nullableNum(serverChecks.homepageStatus) >= 400) add('Homepage HTTP status issue', 1, 'high');
  if (serverChecks.homepageCanonicalMatches === false) add('Canonical mismatch issue', 1, 'high');
  if (Array.isArray(serverChecks.aiBotsBlocked) && serverChecks.aiBotsBlocked.length > 0) {
    add('AI crawler blocking issue', serverChecks.aiBotsBlocked.length, 'high');
  }
  if (nullableNum(serverChecks.sitemapStatus) && nullableNum(serverChecks.sitemapStatus) >= 400) add('Sitemap availability issue', 1, 'medium');
  return issues;
}

function internalReadinessScore(input = {}, visitorExperience = 0) {
  const coverageScore =
    typeof input.coverageConfidence === 'number'
      ? input.coverageConfidence
      : input.coverageGaps?.length
        ? Math.max(0, 100 - input.coverageGaps.length)
        : null;
  return clampScore(
    average([
      input.authorityScore ?? null,
      visitorExperience,
      coverageScore,
      input.schemaCompletenessScore,
      input.schemaQualityScore,
      input.indexabilityScore,
      input.extractabilityScore,
      input.trustProofDensityScore,
      input.internalLinkDensityScore,
      input.ctaClarityScore,
      input.schemaTemplateCoverageScore,
      input.canonicalHealthScore,
      input.imageAltCoverageScore,
      input.textDepthScore,
      input.headingStructureScore,
      input.engagementQualityScore,
      input.technicalHealthScore,
      input.formFrictionScore,
      input.searchFrictionScore,
      input.webVitalsScore,
      input.crawlReadinessScore,
    ]) ?? 0
  );
}

export function computeSiteScoreSnapshot(input = {}) {
  const llmSources = input.llmSources || [];
  const sourceScores = {};
  for (const source of llmSources) {
    if (!source.source) continue;
    sourceScores[source.source] = clampScore(source.score ?? fallbackSourceScore(source));
  }

  const visitorExperience = nullableNum(input.readabilityScore) ?? average(input.experienceScores || []) ?? 0;
  const internalReadiness = internalReadinessScore(input, visitorExperience);
  const externalVisibilityComplete = llmSources.some((source) => num(source.mentions) > 0 || num(source.citations) > 0 || nullableNum(source.score) !== null);
  if (!externalVisibilityComplete) sourceScores.internal_readiness = internalReadiness;
  const issueDistribution = summarizeIssueDistribution([...(input.coverageGaps || []), ...buildDerivedIssues(input)]);
  const contentIssues = issueDistribution.reduce((sum, item) => sum + item.count, 0);
  const telemetrySamples = num(input.telemetrySamples);
  const status =
    externalVisibilityComplete && telemetrySamples > 0
      ? 'complete'
      : externalVisibilityComplete
        ? 'partial_telemetry_missing'
        : telemetrySamples > 0
          ? 'partial_external_missing'
          : 'partial_external_missing';

  return {
    modelVersion: SITE_SCORE_MODEL_VERSION,
    scores: {
      overallAiVisibility: clampScore(externalVisibilityComplete ? average(Object.values(sourceScores)) : internalReadiness),
      visitorExperience: clampScore(visitorExperience),
      siteAuthority: clampScore(input.authorityScore),
      contentCoverageBand: coverageBand(input.coverageConfidence, contentIssues),
      contentIssues,
      mentions: llmSources.reduce((sum, source) => sum + num(source.mentions), 0),
      citations: llmSources.reduce((sum, source) => sum + num(source.citations), 0),
      citedPages: llmSources.reduce((sum, source) => sum + num(source.citedPages), 0),
    },
    sourceScores,
    issueDistribution,
    evidence: {
      generatedAt: input.generatedAt || new Date().toISOString(),
      scoringInputs: {
        llmSources,
        coverageConfidence: input.coverageConfidence ?? null,
        coverageGapCount: input.coverageGaps?.length ?? 0,
        experienceSamples: input.experienceScores?.length ?? 0,
        readabilityScore: input.readabilityScore ?? null,
        schemaCompletenessScore: input.schemaCompletenessScore ?? null,
        schemaQualityScore: input.schemaQualityScore ?? null,
      },
      schema: {
        completenessScore: input.schemaCompletenessScore ?? null,
        qualityScore: input.schemaQualityScore ?? null,
      },
      readiness: {
        internalReadiness,
        indexabilityScore: input.indexabilityScore ?? null,
        extractabilityScore: input.extractabilityScore ?? null,
        trustProofDensityScore: input.trustProofDensityScore ?? null,
        internalLinkDensityScore: input.internalLinkDensityScore ?? null,
        ctaClarityScore: input.ctaClarityScore ?? null,
        schemaTemplateCoverageScore: input.schemaTemplateCoverageScore ?? null,
        canonicalHealthScore: input.canonicalHealthScore ?? null,
        imageAltCoverageScore: input.imageAltCoverageScore ?? null,
        textDepthScore: input.textDepthScore ?? null,
        headingStructureScore: input.headingStructureScore ?? null,
        engagementQualityScore: input.engagementQualityScore ?? null,
        technicalHealthScore: input.technicalHealthScore ?? null,
        formFrictionScore: input.formFrictionScore ?? null,
        searchFrictionScore: input.searchFrictionScore ?? null,
        webVitalsScore: input.webVitalsScore ?? null,
        crawlReadinessScore: input.crawlReadinessScore ?? null,
      },
      dataCompleteness: {
        status,
        externalVisibilityComplete,
        telemetrySamples,
        missing: {
          dataForSeo: !externalVisibilityComplete,
          telemetry: telemetrySamples === 0,
        },
      },
      freshness: {
        generatedAt: input.generatedAt || new Date().toISOString(),
        modelVersion: SITE_SCORE_MODEL_VERSION,
      },
      serverChecks: input.serverChecks ?? null,
    },
  };
}
