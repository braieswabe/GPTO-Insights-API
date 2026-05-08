import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapSiteRowToSitesListEntry } from '../src/site-connection.js';

describe('mapSiteRowToSitesListEntry', () => {
  const thresholds = { connectedMs: 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 };
  const t0 = new Date('2026-05-08T12:00:00.000Z');

  it('sets dataConnection connected when fresh telemetry and active config', () => {
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      domain: 'example.com',
      status: 'pending',
      created_at: new Date('2026-01-01'),
      updated_at: new Date('2026-01-02'),
      last_telemetry_at: new Date('2026-05-08T11:30:00.000Z'),
    };
    const active = new Set([String(row.id)]);
    const entry = mapSiteRowToSitesListEntry(row, active, t0, thresholds);
    assert.equal(entry.dataConnection, 'connected');
    assert.equal(entry.hasActiveConfig, true);
    assert.match(entry.lastTelemetryAt, /^2026-05-08T11:30:00/);
  });

  it('sets dataConnection stale when fresh telemetry but no active config', () => {
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440001',
      domain: 'other.com',
      status: 'active',
      created_at: null,
      updated_at: null,
      last_telemetry_at: new Date('2026-05-08T11:30:00.000Z'),
    };
    const entry = mapSiteRowToSitesListEntry(row, new Set(), t0, thresholds);
    assert.equal(entry.dataConnection, 'stale');
    assert.equal(entry.hasActiveConfig, false);
  });
});
