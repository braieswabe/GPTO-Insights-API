import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDashboardPrewarmTargets,
  composeDashboardOverviewFromModulePayloads,
  shouldQueueDashboardRefresh,
  shouldServeCachedDashboardRow,
} from '../src/services/dashboard.js';

describe('dashboard overview cache composition', () => {
  it('assembles an overview from completed module payloads without recomputing them', () => {
    const overview = composeDashboardOverviewFromModulePayloads(
      [{ id: 'site-1', domain: 'example.com' }],
      {
        telemetry: { totals: { pageViews: 12, visits: 4 } },
        authority: { authorityScore: 77, band: 'strong' },
        executive_summary: { focusLanes: { performingWell: { items: [] } }, signalChips: [] },
        experience: { healthScore: 82 },
        search_diagnostics: { searches: 3 },
        confusion: { totals: { repeatedSearches: 1, deadEnds: 0, dropOffs: 0, intentMismatches: 0 } },
        coverage: { totals: { priorityFixes: 2 } },
        schema: { completenessScore: 90 },
        journey: { rowCount: 5 },
        index: { dashboards: [{ id: 'dash-1' }], llmAiVisibility: { score: 60 } },
        ai_readability: { score: 81 },
        llm_mentions_overview: { aiVisibility: { composite: 66 }, summary: { metrics: { mentions: 9 } } },
      }
    );

    assert.equal(overview.sites, 1);
    assert.equal(overview.display.telemetry.pageViews, 12);
    assert.equal(overview.display.aiVisibility.composite, 66);
    assert.deepEqual(overview.dashboardIndex, [{ id: 'dash-1' }]);
  });
});

describe('dashboard cache read policy', () => {
  it('serves any existing cache row immediately', () => {
    assert.equal(shouldServeCachedDashboardRow(null), false);
    assert.equal(shouldServeCachedDashboardRow({ payload: { ok: true }, expires_at: new Date(Date.now() - 60000) }), true);
  });

  it('recomputes cached overview rows missing the display contract', () => {
    assert.equal(shouldServeCachedDashboardRow({ payload: { telemetry: {} } }, 'overview'), false);
    assert.equal(
      shouldServeCachedDashboardRow(
        { payload: { telemetry: {}, display: {}, executiveSummary: { focusLanes: { performingWell: { items: [] } } } } },
        'overview'
      ),
      true
    );
  });

  it('recomputes cached overview rows missing server-built focusLanes', () => {
    assert.equal(
      shouldServeCachedDashboardRow(
        { payload: { telemetry: {}, display: {}, executiveSummary: {} } },
        'overview'
      ),
      false
    );
  });

  it('recomputes cached export_data rows missing journey or searchDiagnostics', () => {
    assert.equal(shouldServeCachedDashboardRow({ payload: { display: {} } }, 'export_data'), false);
    assert.equal(
      shouldServeCachedDashboardRow({ payload: { display: {}, journey: null, searchDiagnostics: null } }, 'export_data'),
      true
    );
  });

  it('recomputes cached gold rows missing gateway-owned visitor scoring', () => {
    assert.equal(shouldServeCachedDashboardRow({ payload: { optimisationAxes: {} } }, 'gold'), false);
    assert.equal(shouldServeCachedDashboardRow({
      payload: {
        optimisationAxes: {
          technicalReadiness: { plainLanguage: 'Technical signal.' },
        },
        customerInsights: {
          visitorBehavior: { score: 80 },
        },
      },
    }, 'gold'), true);
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
        'admin:csuite:site-1:7d',
        'admin:monthly_insights:site-1:7d',
        'employee:llm_mentions_overview:site-1:7d',
      ]
    );
  });
});
