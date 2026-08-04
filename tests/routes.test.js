import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/routes.js';
import { setDashboardReportBundleReaderForTests } from '../src/services/dashboard.js';
import { composeReportPayload } from '../src/pdf/compose.js';
import { technicalAppendixData } from '../src/pdf/render.js';

process.env.INTERNAL_API_TOKEN ||= 'test-token';

function makeRequest(method, pathname, options = {}) {
  const url = new URL(pathname, 'http://localhost:4011');
  if (options.searchParams) {
    for (const [k, v] of Object.entries(options.searchParams)) {
      url.searchParams.set(k, v);
    }
  }
  return {
    method,
    url,
    headers: {
      authorization: `Bearer ${process.env.INTERNAL_API_TOKEN || 'test-token'}`,
      'x-gpto-user-role': 'admin',
      ...options.headers,
    },
    body: options.body || '',
  };
}

describe('route()', () => {
  it('returns 200 for root', async () => {
    const result = await route(makeRequest('GET', '/'));
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.service, 'gpto-insights-gateway');
  });

  it('returns 200 for health check', async () => {
    const result = await route(makeRequest('GET', '/internal/health'));
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.ok(result.body.time);
  });

  it('serves a dashboard page with a manual daily rollup control', async () => {
    const result = await route(makeRequest('GET', '/dashboard'));
    assert.equal(result.status, 200);
    assert.equal(result.binary, true);
    const html = result.body.toString('utf8');
    assert.match(html, /Run daily rollups/);
    assert.match(html, /internal\/rollup\/telemetry-daily/);
    assert.match(html, /internal\/refresh\/dashboard/);
  });

  it('returns 204 for favicon', async () => {
    const result = await route(makeRequest('GET', '/favicon.ico'));
    assert.equal(result.status, 204);
  });

  it('returns 404 for unknown path', async () => {
    const result = await route(makeRequest('GET', '/v1/unknown'));
    assert.equal(result.status, 404);
  });

  it('returns 401 without token', async () => {
    const req = makeRequest('GET', '/v1/dashboard/overview');
    req.headers.authorization = '';
    try {
      await route(req);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.equal(error.statusCode, 401);
    }
  });

  it('returns 404 for unsupported module', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    const req = makeRequest('GET', '/v1/dashboard/module/nonexistent', {
      searchParams: { range: '7d' },
    });
    const result = await route(req);
    assert.equal(result.status, 404);
    assert.ok(result.body.error.includes('Unsupported'));
  });

  it('returns 400 for LLM mentions without siteId', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    const req = makeRequest('GET', '/v1/llm-mentions/overview');
    const result = await route(req);
    assert.equal(result.status, 400);
  });

  it('returns 400 for LLM mentions bundle without siteId', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    const req = makeRequest('GET', '/v1/llm-mentions/bundle');
    const result = await route(req);
    assert.equal(result.status, 400);
  });

  it('returns 400 for gold dashboard without siteId before touching builders', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    const req = makeRequest('GET', '/v1/dashboard/gold');
    const result = await route(req);
    assert.equal(result.status, 400);
  });

  it('returns 400 for malformed customer user ids before Postgres casts', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    const req = makeRequest('GET', '/v1/dashboard/gold', {
      searchParams: {
        siteId: '00000000-0000-4000-8000-000000000001',
        portal: 'customer',
      },
      headers: {
        'x-gpto-user-role': 'client',
        'x-gpto-user-id': 'codex-smoke',
      },
    });

    await assert.rejects(
      () => route(req),
      (error) => error.statusCode === 400 && error.message === 'Invalid x-gpto-user-id header'
    );
  });

  it('returns 400 for malformed customer tenant ids before Postgres casts', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    const req = makeRequest('GET', '/v1/dashboard/gold', {
      searchParams: {
        siteId: '00000000-0000-4000-8000-000000000001',
        portal: 'customer',
      },
      headers: {
        'x-gpto-user-role': 'client',
        'x-gpto-user-id': '00000000-0000-4000-8000-000000000002',
        'x-gpto-tenant-id': 'tenant-smoke',
      },
    });

    await assert.rejects(
      () => route(req),
      (error) => error.statusCode === 400 && error.message === 'Invalid x-gpto-tenant-id header'
    );
  });

  it('returns 401 for dashboard bundle without token', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    const req = makeRequest('GET', '/v1/dashboard/bundle');
    req.headers.authorization = '';
    try {
      await route(req);
      assert.fail('Should have thrown');
    } catch (error) {
      assert.equal(error.statusCode, 401);
    }
  });

  it('serves DataForSEO locations metadata without requiring a site', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    const req = makeRequest('POST', '/v1/llm-mentions/raw', {
      body: JSON.stringify({ endpoint: 'locations_and_languages' }),
      headers: { 'content-type': 'application/json' },
    });
    const result = await route(req);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.status_code, 20000);
    assert.ok(result.body.data.tasks[0].result.length > 0);
  });

  it('returns a client dashboard PDF export from the gateway', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    setDashboardReportBundleReaderForTests(async () => ({
      status: 200,
      body: { data: { report: fixtureReport() } },
    }));
    try {
      const result = await route(makeRequest('GET', '/v1/dashboard/export', {
        searchParams: { format: 'pdf', range: '7d', siteId: '11111111-1111-1111-1111-111111111111', mode: 'client' },
      }));
      assert.equal(result.status, 200);
      assert.equal(result.binary, true);
      assert.equal(result.headers['content-type'], 'application/pdf');
      assert.match(result.headers['content-disposition'], /client/);
      assert.ok(Buffer.isBuffer(result.body));
      assert.ok(result.body.byteLength > 1000);
    } finally {
      setDashboardReportBundleReaderForTests(null);
    }
  });

  it('returns a technical dashboard PDF export for employee users', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    setDashboardReportBundleReaderForTests(async () => ({
      status: 200,
      body: { data: { report: fixtureReport() } },
    }));
    try {
      const result = await route(makeRequest('GET', '/v1/dashboard/export', {
        searchParams: { format: 'pdf', range: '30d', mode: 'technical' },
        headers: { 'x-gpto-user-role': 'employee' },
      }));
      assert.equal(result.status, 200);
      assert.equal(result.binary, true);
      assert.match(result.headers['content-disposition'], /technical/);
      assert.ok(result.body.byteLength > 1000);
    } finally {
      setDashboardReportBundleReaderForTests(null);
    }
  });

  it('downgrades technical dashboard export mode for unauthorized roles', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-token';
    setDashboardReportBundleReaderForTests(async () => ({
      status: 200,
      body: { data: { report: fixtureReport() } },
    }));
    try {
      const result = await route(makeRequest('GET', '/v1/dashboard/export', {
        searchParams: { format: 'json', range: '7d', mode: 'technical' },
        headers: { 'x-gpto-user-role': 'viewer' },
      }));
      assert.equal(result.status, 200);
      assert.equal(result.body.mode, 'client');
      assert.match(result.headers['content-disposition'], /client/);
    } finally {
      setDashboardReportBundleReaderForTests(null);
    }
  });

  it('normalizes real gateway LLM result shapes for the technical appendix', () => {
    const payload = composeReportPayload({
      bundle: fixtureReport(),
      rangeKey: '7d',
      start: new Date('2026-05-01'),
      end: new Date('2026-05-08'),
      siteId: '11111111-1111-1111-1111-111111111111',
      mode: 'technical',
    });
    const appendix = technicalAppendixData(payload);
    assert.equal(appendix.competitorRows.length, 2);
    assert.equal(appendix.sourceGap.length, 1);
    assert.equal(appendix.sourceGap[0].question, 'Which AI search readiness platforms are best?');
  });
});

function fixtureReport() {
  return {
    telemetry: {
      totals: { visits: 1240, pageViews: 3110, searches: 84 },
      trend: { visits: 12, pageViews: 18 },
      topPages: [
        { url: 'https://acme.example/pricing', count: 420 },
        { url: 'https://acme.example/services', count: 315 },
      ],
      anomalies: [{ message: 'Search bounce rate increased on pricing queries.' }],
    },
    authority: {
      authorityScore: 78,
      blockers: ['Add reviewer credentials to service pages.'],
    },
    schema: {
      completenessScore: 82,
    },
    coverage: {
      totals: { priorityFixes: 4 },
      gaps: [{ detail: 'Create comparison content for alternatives searches.' }],
    },
    confusion: {
      recommendedFixes: ['Add FAQ schema to pricing.', 'Move demo CTA higher on mobile.'],
    },
    executiveSummary: {
      insights: [
        { question: 'What is working?', answer: 'AI tools cite the strongest service pages.' },
        { question: 'What should change?', answer: 'Improve pricing answers and comparison coverage.' },
      ],
      aiVisibility: {
        composite: 73,
        narrative: 'AI visibility is healthy, with clear next steps in pricing and comparison content.',
        buckets: { reach: 76, citation: 71 },
      },
    },
    aiReadability: {
      overall: { score: 81, grade: 'A-' },
    },
    llmMentions: {
      siteDomain: 'acme.example',
      summary: {
        metrics: { mentions: 48, aiSearchVolume: 9200, shareOfVoice: 0.34 },
        topPages: [{ url: 'https://acme.example/pricing', mentions: 12, aiSearchVolume: 2400 }],
        topDomains: [{ domain: 'acme.example', mentions: 20, aiSearchVolume: 4100 }],
      },
    },
    llmMentionsSourceGap: {
      summary: { counts: { protect: 1, optimize: 1, create: 0 } },
      opportunities: [{ question: 'Which AI search readiness platforms are best?', outcome: 'retrieved_not_cited' }],
    },
    llmMentionsCompetitors: {
      comparison: [
        { target: 'acme.example', mentions: 48, aiSearchVolume: 9200, shareOfVoice: 0.34 },
        { target: 'rival.example', mentions: 55, aiSearchVolume: 10200, shareOfVoice: 0.39 },
      ],
    },
    siteDetail: {
      site: { domain: 'acme.example', name: 'Acme Inc' },
      config: { panthera_blackbox: { site: { brand: 'Acme Inc' } } },
    },
  };
}
