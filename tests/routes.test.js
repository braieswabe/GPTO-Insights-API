import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/routes.js';

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
});
