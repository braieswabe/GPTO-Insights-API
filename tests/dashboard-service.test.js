import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDashboardPrewarmTargets,
  shouldQueueDashboardRefresh,
  shouldServeCachedDashboardRow,
} from '../src/services/dashboard.js';

describe('dashboard cache read policy', () => {
  it('serves any existing cache row immediately', () => {
    assert.equal(shouldServeCachedDashboardRow(null), false);
    assert.equal(shouldServeCachedDashboardRow({ payload: { ok: true }, expires_at: new Date(Date.now() - 60000) }), true);
  });

  it('queues refresh only for stale cache rows', () => {
    assert.equal(shouldQueueDashboardRefresh(null), false);
    assert.equal(shouldQueueDashboardRefresh({ expires_at: new Date(Date.now() - 60000) }), true);
    assert.equal(shouldQueueDashboardRefresh({ expires_at: new Date(Date.now() + 60000) }), false);
  });
});

describe('dashboard prewarm targets', () => {
  it('covers common all-sites and per-site dashboard views', () => {
    const targets = buildDashboardPrewarmTargets([{ id: 'site-1' }], { ranges: ['7d'], portalScopes: ['admin'] });
    assert.deepEqual(
      targets.map((target) => `${target.portalScope}:${target.moduleKey}:${target.siteId || 'all'}:${target.rangeKey}`),
      [
        'admin:overview:all:7d',
        'admin:stats:all:7d',
        'admin:overview:site-1:7d',
        'admin:stats:site-1:7d',
        'customer:gold:site-1:7d',
        'employee:llm_mentions_overview:site-1:7d',
      ]
    );
  });
});
