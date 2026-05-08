import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { materializeSignalsOnGptoSuite } from '../src/services/gpto-signal-materialize.js';

describe('materializeSignalsOnGptoSuite', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.GPTO_DASHBOARD_BASE_URL;
    delete process.env.GPTO_SIGNAL_MATERIALIZE_TOKEN;
    delete process.env.GPTO_MATERIALIZE_RANGES;
  });

  it('skips when base URL or token missing', async () => {
    process.env.GPTO_DASHBOARD_BASE_URL = 'https://suite.example';
    const r = await materializeSignalsOnGptoSuite({});
    assert.equal(r.skipped, true);
    assert.match(r.message, /skipped/i);
  });

  it('POSTs to GPTO and returns body on success', async () => {
    process.env.GPTO_DASHBOARD_BASE_URL = 'https://suite.example/';
    process.env.GPTO_SIGNAL_MATERIALIZE_TOKEN = 'tok';
    process.env.GPTO_MATERIALIZE_RANGES = '7d,30d';

    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://suite.example/api/internal/signals/materialize');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer tok');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.ranges, ['7d', '30d']);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, message: 'done' }),
      };
    };

    const r = await materializeSignalsOnGptoSuite({ siteId: 'abc' });
    assert.equal(r.skipped, false);
    assert.equal(r.body.ok, true);
  });

  it('throws on non-2xx', async () => {
    process.env.GPTO_DASHBOARD_BASE_URL = 'https://suite.example';
    process.env.GPTO_SIGNAL_MATERIALIZE_TOKEN = 'tok';
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });
    await assert.rejects(materializeSignalsOnGptoSuite({}), /HTTP 500/);
  });

  it('throws when JSON body has ok false', async () => {
    process.env.GPTO_DASHBOARD_BASE_URL = 'https://suite.example';
    process.env.GPTO_SIGNAL_MATERIALIZE_TOKEN = 'tok';
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false, message: 'bad upsert' }),
    });
    await assert.rejects(materializeSignalsOnGptoSuite({}), /bad upsert/);
  });
});
