import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertUtcRangeWithin,
  isUtcDayString,
  utcDayExclusiveEnd,
  utcDayStart,
  utcDaysInclusive,
} from '../src/telemetry-rollup-dates.js';

describe('telemetry-rollup-dates', () => {
  it('validates UTC day strings', () => {
    assert.equal(isUtcDayString('2026-01-08'), true);
    assert.equal(isUtcDayString('2026-1-08'), false);
    assert.equal(isUtcDayString('2026-01-8'), false);
  });

  it('utcDayStart is UTC midnight', () => {
    const d = utcDayStart('2026-05-08');
    assert.equal(d.toISOString(), '2026-05-08T00:00:00.000Z');
  });

  it('utcDayExclusiveEnd is next UTC day', () => {
    const end = utcDayExclusiveEnd('2026-05-08');
    assert.equal(end.toISOString(), '2026-05-09T00:00:00.000Z');
  });

  it('utcDaysInclusive spans correctly', () => {
    assert.deepEqual(utcDaysInclusive('2026-05-06', '2026-05-08'), ['2026-05-06', '2026-05-07', '2026-05-08']);
  });

  it('assertUtcRangeWithin enforces max span', () => {
    assert.throws(() => assertUtcRangeWithin('2026-01-01', '2026-12-31', 10), /exceeds max/);
  });
});
