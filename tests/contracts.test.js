import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computedFreshness, normalizeSources, parsePagination, parsePositiveInt, requireSiteId, responseEnvelope } from '../src/contracts.js';
import { canCallDataForSeo, dataForSeoAuthHeader } from '../src/services/dataforseo.js';

describe('contract helpers', () => {
  it('normalizes LLM sources to supported values', () => {
    assert.deepEqual(normalizeSources('chat_gpt,google_ai_overviews,gemini'), ['chat_gpt', 'google_ai_overviews', 'gemini']);
    assert.deepEqual(normalizeSources('unknown'), ['chat_gpt', 'google_ai_overviews', 'gemini', 'claude']);
  });

  it('parses bounded positive integers', () => {
    assert.equal(parsePositiveInt('25', 7, { min: 1, max: 30 }), 25);
    assert.equal(parsePositiveInt('250', 7, { min: 1, max: 30 }), 30);
    assert.equal(parsePositiveInt('nope', 7), 7);
  });

  it('parses pagination', () => {
    const search = new URLSearchParams('limit=500&offset=2');
    assert.deepEqual(parsePagination(search), { limit: 200, offset: 2 });
  });

  it('throws a 400 for missing siteId', () => {
    assert.throws(() => requireSiteId(new URLSearchParams()), { statusCode: 400 });
  });

  it('builds stable response envelopes', () => {
    const freshness = computedFreshness();
    const envelope = responseEnvelope({ key: 'telemetry', data: { ok: true }, freshness });
    assert.deepEqual(envelope.data, { ok: true });
    assert.equal(envelope.freshness.telemetry.status, 'computed');
    assert.equal(envelope.stale, false);
  });
});

describe('DataForSEO service contract', () => {
  it('does not allow live calls without auth and payload', () => {
    const previous = process.env.DATAFORSEO_AUTH_HEADER;
    const previousLogin = process.env.DATAFORSEO_LOGIN;
    const previousPassword = process.env.DATAFORSEO_PASSWORD;
    delete process.env.DATAFORSEO_AUTH_HEADER;
    delete process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_PASSWORD;
    assert.equal(dataForSeoAuthHeader(), null);
    assert.equal(canCallDataForSeo('aggregated_metrics', { target: ['example.com'] }), false);
    if (previous) process.env.DATAFORSEO_AUTH_HEADER = previous;
    if (previousLogin) process.env.DATAFORSEO_LOGIN = previousLogin;
    if (previousPassword) process.env.DATAFORSEO_PASSWORD = previousPassword;
  });
});
