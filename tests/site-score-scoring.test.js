import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSiteScoreSnapshot } from '../src/lib/site-score-scoring.js';

function gaps(label, count, severity, pages) {
  return Array.from({ length: count }, (_, issueIndex) => ({ label, severity, pages, issueIndex: issueIndex + 1 }));
}

test('site score scorer matches CRST golden calibration', () => {
  const result = computeSiteScoreSnapshot({
    authorityScore: 37,
    readabilityScore: 52,
    coverageConfidence: 80,
    coverageGaps: [
      ...gaps('Low HTML to Text Ratio', 45, 'medium', ['https://www.crst.com/resources/', 'https://www.crst.com/about-crst/']),
      ...gaps('Duplicate Content', 11, 'high', ['https://www.crst.com/', 'https://crst.com/']),
      ...gaps('Returned 401 Status', 6, 'high', ['https://www.crst.com/blog/truckers-gift-guide/']),
      ...gaps('Incorrect pages in sitemap', 2, 'medium', ['https://www.crst.com/resources/']),
      ...gaps('Slow loading speed', 2, 'high', ['https://careers.crst.com/equipment-leasing', 'https://www.crst.com/equipment-sales/']),
    ],
    llmSources: [
      { source: 'chat_gpt', score: 28, mentions: 420, citations: 176, citedPages: 112, aiSearchVolume: 15200, impressions: 61100 },
      { source: 'google_ai_overviews', score: 48, mentions: 478, citations: 209, citedPages: 139, aiSearchVolume: 18100, impressions: 74200 },
    ],
  });

  assert.deepEqual(result.scores, {
    overallAiVisibility: 38,
    visitorExperience: 52,
    siteAuthority: 37,
    contentCoverageBand: 'High',
    contentIssues: 66,
    mentions: 898,
    citations: 385,
    citedPages: 251,
  });
  assert.deepEqual(result.sourceScores, { chat_gpt: 28, google_ai_overviews: 48 });
});

test('site score scorer produces telemetry-backed live scorecard without DataForSEO', () => {
  const result = computeSiteScoreSnapshot({
    authorityScore: 64,
    readabilityScore: 72,
    coverageConfidence: 76,
    telemetrySamples: 12,
    schemaCompletenessScore: 80,
    schemaQualityScore: 74,
    indexabilityScore: 90,
    extractabilityScore: 70,
    trustProofDensityScore: 55,
    internalLinkDensityScore: 68,
    ctaClarityScore: 82,
    schemaTemplateCoverageScore: 60,
    canonicalHealthScore: 100,
    imageAltCoverageScore: 90,
    textDepthScore: 76,
    headingStructureScore: 84,
    engagementQualityScore: 75,
    technicalHealthScore: 88,
    formFrictionScore: 100,
    searchFrictionScore: 90,
    webVitalsScore: 82,
    crawlReadinessScore: 84,
  });

  assert.equal(result.scores.mentions, 0);
  assert.equal(result.scores.citations, 0);
  assert.ok(result.scores.overallAiVisibility > 0);
  assert.equal(result.sourceScores.internal_readiness, result.scores.overallAiVisibility);
  assert.equal(result.evidence.dataCompleteness.status, 'partial_external_missing');
  assert.equal(result.evidence.dataCompleteness.missing.dataForSeo, true);
  assert.equal(result.evidence.dataCompleteness.missing.telemetry, false);
});
