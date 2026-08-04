import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardRefreshRetryDelaySeconds,
  retryableDashboardRefreshError,
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
});
