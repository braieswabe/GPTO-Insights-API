import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DashboardRefreshJobTimeoutError,
  dashboardRefreshRetryDelaySeconds,
  dashboardRefreshWorkerBatchSize,
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

  it('claims one expensive dashboard cache job per invocation', () => {
    assert.equal(dashboardRefreshWorkerBatchSize(), 1);
    assert.equal(dashboardRefreshWorkerBatchSize(3), 1);
    assert.equal(dashboardRefreshWorkerBatchSize(10), 1);
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
