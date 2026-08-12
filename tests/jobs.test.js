import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardRefreshEffectivePriority,
  dashboardRefreshPriority,
  refreshJobSiteIdValue,
} from '../src/jobs.js';

describe('refresh job site ids', () => {
  it('stores all-sites refresh jobs with NULL site_id so the sites FK is not violated', () => {
    assert.equal(refreshJobSiteIdValue({ siteId: null }), null);
    assert.equal(refreshJobSiteIdValue({}), null);
  });

  it('stores site-scoped refresh jobs with their real site id', () => {
    const siteId = '439becf4-c754-4fd6-ad8b-c8ad13d602de';
    assert.equal(refreshJobSiteIdValue({ siteId }), siteId);
  });
});

describe('dashboard refresh priorities', () => {
  it('processes frontend Top Pages dependencies before background modules', () => {
    assert.equal(dashboardRefreshPriority('overview'), 10);
    assert.equal(dashboardRefreshPriority('telemetry'), 20);
    assert.equal(dashboardRefreshPriority('authority'), 100);
  });

  it('promotes legacy overview jobs without promoting retried telemetry work', () => {
    assert.equal(dashboardRefreshEffectivePriority({ module_key: 'overview', priority: 200, attempts: 0 }), 10);
    assert.equal(dashboardRefreshEffectivePriority({ module_key: 'telemetry', priority: 100, attempts: 0 }), 20);
    assert.equal(dashboardRefreshEffectivePriority({ module_key: 'telemetry', priority: 100, attempts: 1 }), 100);
    assert.equal(dashboardRefreshEffectivePriority({ module_key: 'authority', priority: 80, attempts: 0 }), 80);
  });
});
