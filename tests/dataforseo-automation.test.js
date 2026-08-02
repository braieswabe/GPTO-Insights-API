import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATAFORSEO_AUTOMATION_ENDPOINTS,
  DATAFORSEO_AUTOMATION_SOURCES,
  dataForSeoAutomationEnabled,
  manilaScheduleKey,
  normalizeManualDataForSeoSource,
} from '../src/services/dataforseo-automation.js';

const originalEnabled = process.env.DATAFORSEO_AUTOMATION_ENABLED;

afterEach(() => {
  if (originalEnabled === undefined) delete process.env.DATAFORSEO_AUTOMATION_ENABLED;
  else process.env.DATAFORSEO_AUTOMATION_ENABLED = originalEnabled;
});

describe('DataForSEO automation configuration', () => {
  it('creates a Manila calendar key at the UTC date boundary', () => {
    assert.equal(manilaScheduleKey(new Date('2026-07-30T15:59:59Z')), '2026-07-30');
    assert.equal(manilaScheduleKey(new Date('2026-07-30T16:00:00Z')), '2026-07-31');
  });

  it('queues exactly the four requested internal endpoints', () => {
    assert.deepEqual(DATAFORSEO_AUTOMATION_ENDPOINTS, [
      'aggregated_metrics',
      'top_domains',
      'top_pages',
      'search',
    ]);
  });

  it('schedules both DataForSEO visibility platforms', () => {
    assert.deepEqual(DATAFORSEO_AUTOMATION_SOURCES, ['chat_gpt', 'google_ai_overviews']);
  });

  it('is opt-in', () => {
    process.env.DATAFORSEO_AUTOMATION_ENABLED = '0';
    assert.equal(dataForSeoAutomationEnabled(), false);
    process.env.DATAFORSEO_AUTOMATION_ENABLED = 'true';
    assert.equal(dataForSeoAutomationEnabled(), true);
  });

  it('keeps dashboard manual runs ChatGPT-only by default and accepts an internal Google override', () => {
    assert.equal(normalizeManualDataForSeoSource(undefined), 'chat_gpt');
    assert.equal(normalizeManualDataForSeoSource('chat_gpt'), 'chat_gpt');
    assert.equal(normalizeManualDataForSeoSource('google_ai_overviews'), 'google_ai_overviews');
    assert.throws(() => normalizeManualDataForSeoSource('gemini'), /source must be one of/);
  });
});
