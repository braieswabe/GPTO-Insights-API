import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  averageEngagementScore,
  buildExperienceHealth,
  buildWeightedBucket,
  clampScore,
  compositeFromBreakdown,
  computeAnswerEvidenceFromExamples,
  computeCitationCoverageScore,
  computeCompetitiveScore,
  computeInternalReadinessScore,
  computeReachScore,
  confidenceToStatus,
  coverageRiskLabel,
  deriveCoverageRiskBand,
  deriveExperienceBand,
  deriveJourneyStrengthBand,
  formatTrendPercent,
  frictionScoreFromConfusion,
  getScoreBand,
  getScoreSeverity,
  hasPositiveLlmMetrics,
  isSiteDomainMatch,
  logScore,
  normalizeDomain,
  trendPercentNumber,
} from '../src/lib/scoring.js';

describe('scoring helpers — clamp/log/normalize', () => {
  it('clampScore normalizes finite numbers and rejects others', () => {
    assert.equal(clampScore(150), 100);
    assert.equal(clampScore(-25), 0);
    assert.equal(clampScore(72.6), 73);
    assert.equal(clampScore('abc'), null);
    assert.equal(clampScore(null), null);
    assert.equal(clampScore(NaN), null);
  });

  it('logScore returns 0 when value is non-positive and null when value is missing', () => {
    assert.equal(logScore(0, 1000), 0);
    assert.equal(logScore(null, 1000), null);
    assert.equal(logScore(1000, 1000), 100);
  });

  it('normalizeDomain strips protocol/www and lowercases', () => {
    assert.equal(normalizeDomain('https://www.Example.com/path'), 'example.com');
    assert.equal(normalizeDomain('Example.com'), 'example.com');
    assert.equal(normalizeDomain(null), null);
  });

  it('isSiteDomainMatch handles exact and subdomain matches', () => {
    assert.equal(isSiteDomainMatch('blog.example.com', 'example.com'), true);
    assert.equal(isSiteDomainMatch('example.com', 'example.com'), true);
    assert.equal(isSiteDomainMatch('example.com', 'other.com'), false);
    assert.equal(isSiteDomainMatch(null, 'example.com'), false);
  });
});

describe('LLM scoring buckets and composite', () => {
  it('computeReachScore averages metrics with anchors', () => {
    const score = computeReachScore({ mentions: 100, aiSearchVolume: 500, impressions: 1000 });
    assert.ok(score >= 50 && score <= 80, `expected mid-band score, got ${score}`);
  });

  it('computeCitationCoverageScore handles empty datasets', () => {
    assert.equal(computeCitationCoverageScore({ topDomains: [], topPages: [], siteDomain: 'example.com' }), null);
  });

  it('computeCompetitiveScore converts share-of-voice fraction to a 0-100 score', () => {
    assert.equal(computeCompetitiveScore(0.45), 45);
    assert.equal(computeCompetitiveScore(null), null);
  });

  it('computeAnswerEvidenceFromExamples blends citation rate + evidence count', () => {
    const score = computeAnswerEvidenceFromExamples([
      { citedDomains: ['example.com'] },
      { citedDomains: [] },
      { citedDomains: ['example.com'] },
    ], 'example.com');
    assert.ok(score >= 40 && score <= 90, `expected score in range, got ${score}`);
  });

  it('computeInternalReadinessScore averages internal signals (inverting confusion)', () => {
    const score = computeInternalReadinessScore({
      authorityScore: 80,
      schemaCompletenessScore: 60,
      confusionScore: 20,
      coverageScore: 70,
      aiSearchScore: 50,
    });
    assert.ok(score && score >= 50 && score <= 90);
  });

  it('hasPositiveLlmMetrics detects any non-zero metric', () => {
    assert.equal(hasPositiveLlmMetrics({ mentions: 0, aiSearchVolume: 10, impressions: 0 }), true);
    assert.equal(hasPositiveLlmMetrics({ mentions: 0, aiSearchVolume: 0, impressions: 0 }), false);
  });

  it('compositeFromBreakdown returns null when no contributions are present', () => {
    const composite = compositeFromBreakdown({
      reach: buildWeightedBucket(null, 35, 0, 0),
      citationCoverage: buildWeightedBucket(null, 20, 0, 0),
      competitivePosition: buildWeightedBucket(null, 20, 0, 0),
      answerEvidence: buildWeightedBucket(null, 15, 0, 0),
      internalReadiness: { score: null, redistributedWeight: 0, freshnessMultiplier: 1, contribution: null },
    });
    assert.equal(composite, null);
  });

  it('compositeFromBreakdown blends LLM + internal contributions', () => {
    const reachWeight = 35;
    const internalScore = 80;
    const reach = buildWeightedBucket(70, reachWeight, reachWeight, 1);
    assert.equal(reach.band, 'Building');
    assert.equal(reach.severity, 'watch');
    const composite = compositeFromBreakdown({
      reach,
      citationCoverage: { score: null, redistributedWeight: 0, freshnessMultiplier: 0, contribution: null },
      competitivePosition: { score: null, redistributedWeight: 0, freshnessMultiplier: 0, contribution: null },
      answerEvidence: { score: null, redistributedWeight: 0, freshnessMultiplier: 0, contribution: null },
      internalReadiness: {
        score: internalScore,
        redistributedWeight: 10,
        freshnessMultiplier: 1,
        contribution: internalScore * 10,
      },
    });
    assert.ok(composite && composite > 0 && composite <= 100);
  });
});

describe('Display bands & severities', () => {
  it('getScoreBand maps to Strong/Building/Limited/Weak', () => {
    assert.equal(getScoreBand(85), 'Strong');
    assert.equal(getScoreBand(60), 'Building');
    assert.equal(getScoreBand(30), 'Limited');
    assert.equal(getScoreBand(10), 'Weak');
    assert.equal(getScoreBand(null), 'Unavailable');
  });

  it('getScoreSeverity returns good/watch/warn/critical/unknown', () => {
    assert.equal(getScoreSeverity(80), 'good');
    assert.equal(getScoreSeverity(60), 'watch');
    assert.equal(getScoreSeverity(30), 'warn');
    assert.equal(getScoreSeverity(10), 'critical');
    assert.equal(getScoreSeverity(null), 'unknown');
  });

  it('confidenceToStatus translates High/Medium/Low to Strong/Watch/Weak/Idle', () => {
    assert.equal(confidenceToStatus('High'), 'Strong');
    assert.equal(confidenceToStatus('Medium'), 'Watch');
    assert.equal(confidenceToStatus('Low'), 'Weak');
    assert.equal(confidenceToStatus(null), 'Idle');
  });

  it('coverage risk band reflects priorityFixes/missingFunnelStages', () => {
    assert.equal(deriveCoverageRiskBand({ priorityFixes: 5, missingFunnelStages: 0 }), 'high');
    assert.equal(deriveCoverageRiskBand({ priorityFixes: 0, missingFunnelStages: 1 }), 'medium');
    assert.equal(deriveCoverageRiskBand({ priorityFixes: 0, missingFunnelStages: 0, contentGaps: 0 }), 'minimal');
    assert.equal(coverageRiskLabel({ priorityFixes: 5, missingFunnelStages: 0 }), 'High');
    assert.equal(coverageRiskLabel({ priorityFixes: 0, missingFunnelStages: 0, contentGaps: 0 }), 'Low');
  });

  it('journey/experience bands scale with row counts', () => {
    assert.equal(deriveJourneyStrengthBand(7), 'Strong');
    assert.equal(deriveJourneyStrengthBand(2), 'Watch');
    assert.equal(deriveJourneyStrengthBand(0), 'Idle');

    assert.equal(deriveExperienceBand(7), 'Strong');
    assert.equal(deriveExperienceBand(2), 'Watch');
    assert.equal(deriveExperienceBand(0), 'Idle');
  });
});

describe('Pulse blends', () => {
  it('frictionScoreFromConfusion returns null without confusion data', () => {
    assert.equal(frictionScoreFromConfusion(null, { totals: { visits: 100 } }), null);
  });

  it('frictionScoreFromConfusion penalizes high friction per session', () => {
    const score = frictionScoreFromConfusion(
      { totals: { repeatedSearches: 4, deadEnds: 0, dropOffs: 1 }, signals: { dropOffs: [] } },
      { totals: { visits: 100, pageViews: 100 } }
    );
    assert.ok(typeof score === 'number' && score >= 0 && score <= 100);
  });

  it('averageEngagementScore averages page scores', () => {
    const score = averageEngagementScore({ pages: [{ score: 80 }, { score: 60 }, { score: 40 }] });
    assert.equal(score, 60);
    assert.equal(averageEngagementScore({ pages: [] }), null);
  });

  it('buildExperienceHealth blends friction + engagement when both present', () => {
    const blend = buildExperienceHealth(
      { totals: { repeatedSearches: 0, deadEnds: 0, dropOffs: 0 }, signals: { dropOffs: [] } },
      { pages: [{ score: 70 }, { score: 50 }] },
      { totals: { visits: 100, pageViews: 100 } }
    );
    assert.equal(blend.source, 'blended');
    assert.equal(typeof blend.score, 'number');
  });
});

describe('Trend formatting', () => {
  it('trendPercentNumber returns rounded percent', () => {
    assert.equal(trendPercentNumber(0.124), 12.4);
    assert.equal(trendPercentNumber(null), null);
  });

  it('formatTrendPercent returns +/- prefixed string', () => {
    assert.equal(formatTrendPercent(0.124), '+12.4%');
    assert.equal(formatTrendPercent(-0.1), '-10.0%');
    assert.equal(formatTrendPercent(null), null);
  });
});
