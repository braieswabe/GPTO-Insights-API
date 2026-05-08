import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ttlForModule } from '../src/types.js';

describe('AI report service module', () => {
  it('has a dedicated TTL', () => {
    assert.equal(ttlForModule('ai_report'), 6 * 60 * 60);
  });

  it('exposes readDashboardAiReport from services/ai-report.js', async () => {
    const mod = await import('../src/services/ai-report.js');
    assert.equal(typeof mod.readDashboardAiReport, 'function');
  });
});

describe('CSuite builder module', () => {
  it('exposes buildCsuite + buildMonthlyInsights', async () => {
    const mod = await import('../src/builders/csuite.js');
    assert.equal(typeof mod.buildCsuite, 'function');
    assert.equal(typeof mod.buildMonthlyInsights, 'function');
  });
});

describe('Routes wire-up', () => {
  it('routes module exports a route() function', async () => {
    const { route } = await import('../src/routes.js');
    assert.equal(typeof route, 'function');
  });

  it('exposes the site-scoped dashboard and LLM bundle readers', async () => {
    const dashboard = await import('../src/services/dashboard.js');
    const llm = await import('../src/services/llm-mentions.js');
    assert.equal(typeof dashboard.readDashboardGold, 'function');
    assert.equal(typeof dashboard.readDashboardCsuite, 'function');
    assert.equal(typeof dashboard.readDashboardReportBundle, 'function');
    assert.equal(typeof llm.readLlmMentionsBundle, 'function');
  });
});
