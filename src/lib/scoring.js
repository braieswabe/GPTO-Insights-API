/**
 * Shared scoring + display-band helpers used across builders.
 * Mirrors the formulas the GPTO Dashboard previously executed in the browser
 * (see apps/dashboard/src/lib/ai-visibility.ts, components/LlmMentionsDetailView.tsx,
 * components/GoldDashboard.tsx, app/dashboard/page.tsx) so the gateway is the
 * single source of truth for every score, band, and label the UI renders.
 */

const LLM_BUCKET_WEIGHTS = Object.freeze({
  reach: 35,
  citationCoverage: 20,
  competitivePosition: 20,
  answerEvidence: 15,
});

const INTERNAL_WEIGHT = 10;

export function clampScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function average(values) {
  const numbers = (values || []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

export function logScore(value, anchor) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0) return 0;
  if (typeof anchor !== 'number' || anchor <= 0) return null;
  const ratio = Math.log10(value + 1) / Math.log10(anchor + 1);
  return clampScore(ratio * 100);
}

export function normalizeDomain(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return trimmed.replace(/^www\./i, '').toLowerCase();
  }
}

export function isSiteDomainMatch(candidate, siteDomain) {
  if (!siteDomain) return false;
  const site = normalizeDomain(siteDomain);
  const value = normalizeDomain(candidate);
  if (!site || !value) return false;
  return value === site || value.endsWith(`.${site}`);
}

export function computeReachScore(metrics) {
  if (!metrics) return null;
  return clampScore(
    average([
      logScore(metrics.mentions, 1000),
      logScore(metrics.aiSearchVolume, 5000),
      logScore(metrics.impressions, 10000),
    ])
  );
}

export function computeCitationStrengthScore(topDomains = [], topPages = []) {
  const domainStrength = average(
    topDomains.map((row) =>
      average([
        logScore(row.mentions, 250),
        logScore(row.impressions, 2500),
        logScore(row.aiSearchVolume, 1500),
      ])
    )
  );
  const pageStrength = average(
    topPages.map((row) =>
      average([
        logScore(row.mentions, 250),
        logScore(row.impressions, 2500),
        logScore(row.aiSearchVolume, 1500),
      ])
    )
  );
  return clampScore(average([domainStrength, pageStrength]));
}

/**
 * Citation Coverage = blend of "site presence among cited rows" + average
 * citation strength of all rows. Mirrors the LlmMentionsDetailView formula.
 */
export function computeCitationCoverageScore({ topDomains = [], topPages = [], siteDomain }) {
  if (topDomains.length === 0 && topPages.length === 0) return null;

  const scoredRows = [...topDomains, ...topPages].map((row) =>
    average([
      logScore(row.mentions, 250),
      logScore(row.impressions, 2500),
      logScore(row.aiSearchVolume, 1500),
    ])
  );
  const citationStrength = average(scoredRows) ?? 0;
  const siteRows = [
    ...topDomains.filter((row) => isSiteDomainMatch(row.domain, siteDomain)),
    ...topPages.filter((row) => isSiteDomainMatch(row.url, siteDomain)),
  ];
  const sitePresence = siteRows.length > 0 ? 35 : 0;
  return clampScore(sitePresence + citationStrength * 0.65);
}

export function computeCitationEvidenceScore(rows = []) {
  return clampScore(
    average(
      rows.map((row) =>
        average([
          logScore(row.mentions, 250),
          logScore(row.impressions, 2500),
          logScore(row.aiSearchVolume, 1500),
        ])
      )
    )
  );
}

export function computeCompetitiveScore(shareOfVoice) {
  if (typeof shareOfVoice !== 'number' || !Number.isFinite(shareOfVoice)) return null;
  return clampScore(shareOfVoice * 100);
}

export function computeAnswerEvidenceFromExamples(searchExamples = [], siteDomain) {
  if (!searchExamples.length) return null;
  const citedExamples = searchExamples.filter((example) =>
    (example.citedDomains || []).some((domain) => isSiteDomainMatch(domain, siteDomain))
  );
  const retrievedExamples = searchExamples.filter((example) =>
    (example.retrievedDomains || []).some((domain) => isSiteDomainMatch(domain, siteDomain))
  );
  const citedRate = citedExamples.length / searchExamples.length;
  const retrievedRate = retrievedExamples.length / searchExamples.length;
  return clampScore(citedRate * 75 + retrievedRate * 25);
}

export function computeInternalReadinessScore({
  authorityScore = null,
  schemaCompletenessScore = null,
  confusionScore = null,
  coverageScore = null,
  aiSearchScore = null,
} = {}) {
  return clampScore(
    average([
      authorityScore,
      schemaCompletenessScore,
      aiSearchScore,
      coverageScore,
      typeof confusionScore === 'number' ? 100 - confusionScore : null,
    ])
  );
}

export function buildWeightedBucket(score, baseWeight, totalAvailableBaseWeight, freshnessFactor = 1) {
  const redistributedWeight =
    score !== null && totalAvailableBaseWeight > 0 ? (baseWeight / totalAvailableBaseWeight) * 90 : 0;
  const contribution =
    score !== null && redistributedWeight > 0 && freshnessFactor > 0
      ? Number((score * redistributedWeight * freshnessFactor).toFixed(4))
      : null;
  return {
    score,
    redistributedWeight: Number(redistributedWeight.toFixed(4)),
    freshnessMultiplier: freshnessFactor,
    contribution,
  };
}

export function buildInternalBucket(score) {
  return {
    score,
    redistributedWeight: score !== null ? INTERNAL_WEIGHT : 0,
    freshnessMultiplier: 1,
    contribution: score !== null ? Number((score * INTERNAL_WEIGHT).toFixed(4)) : null,
  };
}

export function compositeFromBreakdown(breakdown) {
  const llmContributions = [
    breakdown.reach?.contribution,
    breakdown.citationCoverage?.contribution,
    breakdown.competitivePosition?.contribution,
    breakdown.answerEvidence?.contribution,
  ].filter((value) => typeof value === 'number');

  const internalContribution = breakdown.internalReadiness?.contribution;
  if (llmContributions.length === 0 && typeof internalContribution !== 'number') return null;
  if (llmContributions.length === 0 && typeof internalContribution === 'number') {
    return clampScore(internalContribution / INTERNAL_WEIGHT);
  }

  if (typeof internalContribution === 'number') {
    const total = llmContributions.reduce((sum, value) => sum + value, 0) + internalContribution;
    return clampScore(total / 100);
  }

  const llmOnly = llmContributions.reduce((sum, value) => sum + value, 0);
  return clampScore(llmOnly / 90);
}

export function hasPositiveLlmMetrics(metrics = {}) {
  return ['mentions', 'aiSearchVolume', 'impressions'].some((key) => {
    const value = metrics[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
  });
}

export function getScoreBand(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'Unavailable';
  if (score >= 75) return 'Strong';
  if (score >= 50) return 'Building';
  if (score >= 25) return 'Limited';
  return 'Weak';
}

export function getScoreSeverity(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'unknown';
  if (score >= 75) return 'good';
  if (score >= 50) return 'watch';
  if (score >= 25) return 'warn';
  return 'critical';
}

/**
 * Confidence label coming out of the gateway maps to UI Pulse chip status.
 * Mirrors mapConfidenceToStatus in apps/dashboard/src/app/dashboard/page.tsx.
 */
export function confidenceToStatus(confidence) {
  if (confidence === 'High') return 'Strong';
  if (confidence === 'Medium') return 'Watch';
  if (confidence === 'Low') return 'Weak';
  return 'Idle';
}

/** Coverage risk band (used by main dashboard pulse card). */
export function deriveCoverageRiskBand(totals) {
  if (!totals) return 'unknown';
  const priority = Number(totals.priorityFixes || 0);
  const missingStages = Number(totals.missingFunnelStages || 0);
  const contentGaps = Number(totals.contentGaps || 0);
  if (priority > 3) return 'high';
  if (missingStages > 0) return 'medium';
  if (contentGaps > 0 || priority > 0) return 'low';
  return 'minimal';
}

/** Coverage risk label as the main dashboard prints it (High/Medium/Low). */
export function coverageRiskLabel(totals) {
  const band = deriveCoverageRiskBand(totals);
  if (band === 'high') return 'High';
  if (band === 'medium') return 'Medium';
  if (band === 'low' || band === 'minimal') return 'Low';
  return null;
}

export function deriveJourneyStrengthBand(rowsCount) {
  const count = Number(rowsCount || 0);
  if (count > 5) return 'Strong';
  if (count > 0) return 'Watch';
  return 'Idle';
}

export function deriveExperienceBand(experiencePagesCount) {
  const count = Number(experiencePagesCount || 0);
  if (count > 5) return 'Strong';
  if (count > 0) return 'Watch';
  return 'Idle';
}

/**
 * Friction-based experience score used by main dashboard pulse "Experience health" card.
 * Derived from confusion totals + observed sessions, exactly mirroring the prior
 * client-side formula in apps/dashboard/src/app/dashboard/page.tsx.
 */
export function frictionScoreFromConfusion(confusion, telemetry) {
  if (!confusion?.totals) return null;
  const totals = confusion.totals;
  const friction =
    Number(totals.repeatedSearches || 0) + Number(totals.deadEnds || 0) + Number(totals.dropOffs || 0);
  const dropOffSessions = new Set(
    (confusion.signals?.dropOffs || [])
      .map((row) => row?.sessionId)
      .filter(Boolean)
  ).size;
  const aggregatedPageViews = Number(telemetry?.totals?.pageViews || 0);
  const visits = Number(telemetry?.totals?.visits || 0);
  const estimatedSessions = Math.max(visits, aggregatedPageViews, dropOffSessions, 1);
  const frictionPer100 = (friction / estimatedSessions) * 100;
  const score =
    frictionPer100 <= 5
      ? 100 - frictionPer100 * 3
      : frictionPer100 <= 15
        ? 85 - (frictionPer100 - 5) * 3
        : frictionPer100 <= 30
          ? 55 - (frictionPer100 - 15) * 2
          : 25 - (frictionPer100 - 30);
  return clampScore(score);
}

export function averageEngagementScore(experience) {
  const pages = experience?.pages || [];
  const scored = pages.filter((page) => typeof page.score === 'number' && Number.isFinite(page.score) && page.score > 0);
  if (scored.length === 0) return null;
  return clampScore(scored.reduce((sum, page) => sum + page.score, 0) / scored.length);
}

/**
 * Combined "experience health" score (0-100). Returns the score and the
 * underlying source (`blended`/`friction`/`engagement`/`none`) so the UI knows
 * how it was derived without recomputing.
 */
export function buildExperienceHealth(confusion, experience, telemetry) {
  const frictionScore = frictionScoreFromConfusion(confusion, telemetry);
  const engagementScore = averageEngagementScore(experience);
  if (frictionScore !== null && engagementScore !== null) {
    return { score: clampScore(frictionScore * 0.5 + engagementScore * 0.5), source: 'blended', frictionScore, engagementScore };
  }
  if (frictionScore !== null) return { score: frictionScore, source: 'friction', frictionScore, engagementScore: null };
  if (engagementScore !== null) return { score: engagementScore, source: 'engagement', frictionScore: null, engagementScore };
  return { score: null, source: 'none', frictionScore: null, engagementScore: null };
}

export const LLM_VISIBILITY_WEIGHTS = LLM_BUCKET_WEIGHTS;
export const LLM_INTERNAL_WEIGHT = INTERNAL_WEIGHT;

/** Format a fractional trend value (e.g. 0.124) as a signed percent string ("+12.4%"). */
export function formatTrendPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const pct = value * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/** Numeric trend percent (round to 1 decimal). */
export function trendPercentNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number((value * 100).toFixed(1));
}
