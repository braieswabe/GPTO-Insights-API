import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DashboardRefreshJobTimeoutError,
  dashboardRefreshRetryDelaySeconds,
  dashboardRefreshWorkerBatchSize,
  isIsolatedDashboardRefreshJob,
  retryableDashboardRefreshError,
  shouldRetryDashboardRefreshJob,
  withDashboardRefreshJobDeadline,
} from '../src/jobs.js';

describe('dashboard refresh job reliability', () => {
  it('uses bounded exponential retry delays', () => {
    assert.equal(dashboardRefreshRetryDelaySeconds(1), 30);
    assert.equal(dashboardRefreshRetryDelaySeconds(2), 60);
    assert.equal(dashboardRefreshRetryDelaySeconds(10), 900);
  });

  it('retries transient failures but not validation or authentication failures', () => {
    assert.equal(retryableDashboardRefreshError(new Error('network reset')), true);
    assert.equal(retryableDashboardRefreshError({ statusCode: 503 }), true);
    assert.equal(retryableDashboardRefreshError({ statusCode: 429 }), true);
    assert.equal(retryableDashboardRefreshError({ statusCode: 400 }), false);
    assert.equal(retryableDashboardRefreshError({ statusCode: 401 }), false);
  });

  it('adaptively batches at most three dashboard cache jobs per invocation', () => {
    assert.equal(dashboardRefreshWorkerBatchSize(), 3);
    assert.equal(dashboardRefreshWorkerBatchSize(2), 2);
    assert.equal(dashboardRefreshWorkerBatchSize(10), 3);
    assert.equal(dashboardRefreshWorkerBatchSize(0), 1);
  });

  it('isolates timeout-prone 30-day modules from fast batches', () => {
    assert.equal(isIsolatedDashboardRefreshJob({ module_key: 'telemetry', range_key: '30d' }), true);
    assert.equal(isIsolatedDashboardRefreshJob({ module_key: 'executive_summary', range_key: '30d' }), true);
    assert.equal(isIsolatedDashboardRefreshJob({ module_key: 'telemetry', range_key: '7d' }), false);
    assert.equal(isIsolatedDashboardRefreshJob({ module_key: 'overview', range_key: '30d' }), false);
  });

  it('never retries beyond the third execution attempt', () => {
    const timeout = new DashboardRefreshJobTimeoutError(240_000);
    assert.equal(shouldRetryDashboardRefreshJob(timeout, 1), true);
    assert.equal(shouldRetryDashboardRefreshJob(timeout, 2), true);
    assert.equal(shouldRetryDashboardRefreshJob(timeout, 3), false);
    assert.equal(shouldRetryDashboardRefreshJob(timeout, 17), false);
  });

  it('raises a retryable timeout before the Vercel deadline', async () => {
    await assert.rejects(
      withDashboardRefreshJobDeadline(() => new Promise(() => {}), 5_000),
      (error) => error instanceof DashboardRefreshJobTimeoutError
        && error.retryable === true
        && error.statusCode === 408
        && error.timeoutMs === 5_000
    );
  });
});
