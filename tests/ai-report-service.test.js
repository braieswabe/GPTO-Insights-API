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
});
