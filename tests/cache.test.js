import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashParams, buildCacheIdentity, isCacheStale, serializeCacheRow } from '../src/cache.js';

describe('hashParams()', () => {
  it('returns consistent hash for same params', () => {
    const h1 = hashParams({ a: 1, b: 2 });
    const h2 = hashParams({ b: 2, a: 1 });
    assert.equal(h1, h2);
  });

  it('returns different hash for different params', () => {
    const h1 = hashParams({ a: 1 });
    const h2 = hashParams({ a: 2 });
    assert.notEqual(h1, h2);
  });

  it('handles empty params', () => {
    const h = hashParams({});
    assert.ok(h.length === 64);
  });
});

describe('buildCacheIdentity()', () => {
  it('builds identity with paramsHash', () => {
    const identity = buildCacheIdentity({
      portalScope: 'employee',
      moduleKey: 'telemetry',
      siteId: null,
      rangeKey: '7d',
      params: { portalScope: 'employee' },
    });
    assert.equal(identity.portalScope, 'employee');
    assert.equal(identity.moduleKey, 'telemetry');
    assert.ok(identity.paramsHash.length === 64);
  });
});

describe('isCacheStale()', () => {
  it('returns true for null row', () => {
    assert.equal(isCacheStale(null), true);
  });

  it('returns false for row without expires_at', () => {
    assert.equal(isCacheStale({ expires_at: null }), false);
  });

  it('returns true for expired row', () => {
    const past = new Date(Date.now() - 60000);
    assert.equal(isCacheStale({ expires_at: past }), true);
  });

  it('returns false for fresh row', () => {
    const future = new Date(Date.now() + 60000);
    assert.equal(isCacheStale({ expires_at: future }), false);
  });
});

describe('serializeCacheRow()', () => {
  it('returns null for null row', () => {
    assert.equal(serializeCacheRow(null), null);
  });

  it('serializes row correctly', () => {
    const row = {
      payload: { hello: 'world' },
      status: 'ready',
      generated_at: new Date('2025-01-01'),
      source_watermark_at: null,
      expires_at: new Date('2025-12-31'),
      error: null,
      model_version: 'test.v1',
    };
    const result = serializeCacheRow(row);
    assert.deepEqual(result.payload, { hello: 'world' });
    assert.equal(result.metadata.status, 'ready');
    assert.ok(result.metadata.generatedAt);
  });
});
