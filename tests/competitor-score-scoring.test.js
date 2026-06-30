import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCompetitorScoreSnapshot, normalizeCompetitorDomain } from '../src/lib/competitor-score-scoring.js';

test('competitor scorer computes complete AI competitor scorecard with traffic data', () => {
  const result = computeCompetitorScoreSnapshot({
    domain: 'https://www.schneider.com/path',
    displayName: 'Schneider',
    llmSources: [
      { source: 'chat_gpt', mentions: 510, citations: 220, citedPages: 80, aiSearchVolume: 19400, impressions: 80300, shareOfVoice: 0.43 },
      { source: 'google_ai_overviews', mentions: 620, citations: 260, citedPages: 95, aiSearchVolume: 24100, impressions: 90400, shareOfVoice: 0.46 },
    ],
    websiteAudience: 59500000,
    crawl: { title: 'Schneider', description: 'Transportation services', wordCount: 1200, headingCount: 8, linkCount: 40, schemaTypes: ['Organization', 'WebSite'] },
    serverChecks: { homepageStatus: 200, robotsStatus: 200, sitemapStatus: 200, llmsTxtPresent: true, aiBotsBlocked: [] },
  });

  assert.equal(normalizeCompetitorDomain('https://www.schneider.com/path'), 'schneider.com');
  assert.equal(result.status, 'complete');
  assert.equal(result.scores.mentions, 1130);
  assert.equal(result.scores.websiteAudience, 59500000);
  assert.equal(result.missingData.dataForSeo, false);
  assert.equal(result.missingData.websiteAudience, false);
  assert.ok(Number(result.scores.aiVisibility) > 0);
});

test('competitor scorer uses public estimates when external metrics are missing', () => {
  const result = computeCompetitorScoreSnapshot({
    domain: 'jbhunt.com',
    crawl: { title: 'J.B. Hunt', description: 'Logistics', wordCount: 900, headingCount: 5, linkCount: 20, schemaTypes: ['Organization'] },
    serverChecks: { homepageStatus: 200, aiBotsBlocked: [] },
  });

  assert.equal(result.status, 'partial_external_missing');
  assert.equal(result.dataMode, 'public_estimate');
  assert.equal(result.missingData.publicEstimate, true);
  assert.ok(result.scores.aiVisibility > 0);
  assert.ok(result.scores.mentions > 0);
  assert.ok(result.scores.citations >= 0);
  assert.ok(result.sourceScores.internal_readiness > 0);
  assert.equal(result.missingData.dataForSeo, true);
});

test('competitor scorer marks traffic missing when website audience provider is absent', () => {
  const result = computeCompetitorScoreSnapshot({
    domain: 'swifttrans.com',
    llmSources: [{ source: 'chat_gpt', mentions: 300, citations: 110, citedPages: 40, aiSearchVolume: 15000, impressions: 60000, shareOfVoice: 0.24 }],
    crawl: { title: 'Swift', description: 'Transportation', wordCount: 1000, headingCount: 7, linkCount: 30, schemaTypes: ['Organization'] },
    serverChecks: { homepageStatus: 200, aiBotsBlocked: [] },
  });

  assert.equal(result.status, 'partial_traffic_missing');
  assert.equal(result.missingData.websiteAudience, true);
  assert.equal(result.scores.websiteAudience, null);
});
