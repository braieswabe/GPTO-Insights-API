import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DASHBOARD_MODULES, MODEL_VERSION, ttlForModule, normalizeDashboardModuleKey, normalizePortal, normalizeRange, rangeToDays } from '../src/types.js';

describe('types constants', () => {
  it('has all expected modules', () => {
    assert.ok(DASHBOARD_MODULES.includes('telemetry'));
    assert.ok(DASHBOARD_MODULES.includes('authority'));
    assert.ok(DASHBOARD_MODULES.includes('confusion'));
    assert.ok(DASHBOARD_MODULES.includes('coverage'));
    assert.ok(DASHBOARD_MODULES.includes('schema'));
    assert.ok(DASHBOARD_MODULES.includes('journey'));
    assert.ok(DASHBOARD_MODULES.includes('index'));
    assert.ok(DASHBOARD_MODULES.includes('experience'));
    assert.ok(DASHBOARD_MODULES.includes('search_diagnostics'));
    assert.ok(DASHBOARD_MODULES.includes('executive_summary'));
    assert.ok(DASHBOARD_MODULES.includes('ai_readability'));
    assert.ok(DASHBOARD_MODULES.includes('llm_mentions_overview'));
    assert.ok(DASHBOARD_MODULES.includes('overview'));
    assert.equal(DASHBOARD_MODULES.length, 13);
  });

  it('ttlForModule returns correct TTLs', () => {
    assert.equal(ttlForModule('overview'), 60 * 60);
    assert.equal(ttlForModule('stats'), 60 * 60);
    assert.equal(ttlForModule('telemetry'), 15 * 60);
    assert.equal(ttlForModule('authority'), 30 * 60);
    assert.equal(ttlForModule('coverage'), 60 * 60);
    assert.equal(ttlForModule('llm_mentions_overview'), 6 * 60 * 60);
    assert.equal(ttlForModule('csuite'), 30 * 60);
    assert.equal(ttlForModule('monthly_insights'), 60 * 60);
    assert.equal(ttlForModule('ai_report'), 6 * 60 * 60);
    assert.equal(ttlForModule('unknown'), 30 * 60);
  });

  it('uses bumped model_version for cache invalidation', () => {
    assert.equal(MODEL_VERSION, 'gpto.dashboard.insights.v2.2');
  });

  it('normalizes GPTO public module route aliases', () => {
    assert.equal(normalizeDashboardModuleKey('search-diagnostics'), 'search_diagnostics');
    assert.equal(normalizeDashboardModuleKey('executive-summary'), 'executive_summary');
    assert.equal(normalizeDashboardModuleKey('ai-readability'), 'ai_readability');
    assert.equal(ttlForModule('llm-mentions-overview'), 6 * 60 * 60);
  });

  it('normalizePortal handles values', () => {
    assert.equal(normalizePortal('admin'), 'admin');
    assert.equal(normalizePortal('customer'), 'customer');
    assert.equal(normalizePortal('employee'), 'employee');
    assert.equal(normalizePortal('invalid'), 'employee');
    assert.equal(normalizePortal(null), 'employee');
  });

  it('normalizeRange defaults to 7d', () => {
    assert.equal(normalizeRange('30d'), '30d');
    assert.equal(normalizeRange('7d'), '7d');
    assert.equal(normalizeRange('invalid'), '7d');
    assert.equal(normalizeRange(null), '7d');
  });

  it('rangeToDays converts correctly', () => {
    assert.equal(rangeToDays('7d'), 7);
    assert.equal(rangeToDays('30d'), 30);
    assert.equal(rangeToDays('custom'), 7);
  });
});
