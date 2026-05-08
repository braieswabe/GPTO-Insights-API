import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveDataConnection } from '../src/derive-data-connection.js';

describe('deriveDataConnection', () => {
  const thresholds = { connectedMs: 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 };
  const t0 = new Date('2026-05-08T12:00:00.000Z');

  it('returns connected when telemetry is fresh and config is active', () => {
    const last = new Date('2026-05-08T11:30:00.000Z');
    assert.equal(deriveDataConnection(last, true, t0, thresholds), 'connected');
  });

  it('returns stale when telemetry is fresh but there is no active config', () => {
    const last = new Date('2026-05-08T11:30:00.000Z');
    assert.equal(deriveDataConnection(last, false, t0, thresholds), 'stale');
  });

  it('returns stale when config exists but telemetry is older than connected window', () => {
    const last = new Date('2026-05-08T09:00:00.000Z');
    assert.equal(deriveDataConnection(last, true, t0, thresholds), 'stale');
  });

  it('returns disconnected when telemetry is older than stale window', () => {
    const last = new Date('2026-05-06T12:00:00.000Z');
    assert.equal(deriveDataConnection(last, true, t0, thresholds), 'disconnected');
  });

  it('returns disconnected when there has never been telemetry and no config', () => {
    assert.equal(deriveDataConnection(null, false, t0, thresholds), 'disconnected');
  });

  it('returns stale when there has never been telemetry but portal has active config', () => {
    assert.equal(deriveDataConnection(null, true, t0, thresholds), 'stale');
  });

  it('returns unknown when stale window is tighter than connected window', () => {
    assert.equal(
      deriveDataConnection(new Date('2026-05-08T11:00:00.000Z'), true, t0, {
        connectedMs: 24 * 3600 * 1000,
        staleMs: 3600 * 1000,
      }),
      'unknown'
    );
  });
});
