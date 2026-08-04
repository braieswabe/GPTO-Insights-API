import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readAutomationRuns,
  setAutomationRunsDbReaderForTests,
} from '../src/services/automation-runs.js';
import { postTelemetryDailyRollup } from '../src/services/telemetry-daily-rollup.js';

function request(role = 'admin') {
  return {
    url: new URL('http://localhost/v1/admin/automation-runs?days=7&limit=25'),
    headers: { 'x-gpto-user-role': role },
  };
}

describe('automation run history', () => {
  afterEach(() => setAutomationRunsDbReaderForTests(null));

  it('combines dashboard, DataForSEO, and scanner runs', async () => {
    setAutomationRunsDbReaderForTests(() => async (strings) => {
      const query = strings.join(' ');
      if (query.includes('FROM dashboard_data_refresh_runs')) {
        return [{
          id: 'refresh-1', schedule_key: '2026-08-02T11', mode: 'hourly', status: 'completed',
          stage: 'completed', processed_sites: 3, total_sites: 3, error: null,
          created_at: new Date('2026-08-02T11:00:00Z'), started_at: new Date('2026-08-02T11:00:01Z'),
          finished_at: new Date('2026-08-02T11:01:00Z'), updated_at: new Date('2026-08-02T11:01:00Z'),
        }];
      }
      if (query.includes('FROM dataforseo_automation_batches')) {
        return [{
          id: 'dfs-1', trigger: 'scheduled', schedule_key: '2026-08-02', source: 'chat_gpt',
          status: 'partially_failed', total_jobs: 12, succeeded_jobs: 11, failed_jobs: 1,
          errors: ['vendor timeout'], created_at: new Date('2026-08-02T10:00:00Z'),
          started_at: new Date('2026-08-02T10:00:01Z'), finished_at: new Date('2026-08-02T10:04:00Z'),
          updated_at: new Date('2026-08-02T10:04:00Z'),
        }];
      }
      if (query.includes('FROM automation_cron_attempts')) {
        return [{
          id: 'enqueue-1', system: 'ai_scanner_enqueue', schedule_key: '2026-08-02',
          status: 'failed', failure_code: 'automation_disabled', inserted_runs: 0,
          total_runs: 3, error: 'AI mentions automation is disabled',
          created_at: new Date('2026-08-02T08:30:00Z'), started_at: new Date('2026-08-02T08:30:00Z'),
          finished_at: new Date('2026-08-02T08:30:01Z'), updated_at: new Date('2026-08-02T08:30:01Z'),
        }];
      }
      return [{
        id: 'scan-1', site_id: 'site-1', domain: 'crst.com', status: 'completed',
        scanner_version: 'v2', platforms: ['gemini', 'claude'], prompt_count: 8,
        total_tasks: 16, completed_tasks: 16, failed_tasks: 0, trigger: 'scheduled',
        schedule_key: '2026-08-02', error: null, created_at: new Date('2026-08-02T09:00:00Z'),
        started_at: new Date('2026-08-02T09:00:01Z'), finished_at: new Date('2026-08-02T09:03:00Z'),
        updated_at: new Date('2026-08-02T09:03:00Z'),
      }];
    });

    const result = await readAutomationRuns(request());
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.runs.map((run) => run.type), [
      'dashboard_refresh',
      'dataforseo',
      'ai_scanner',
      'ai_scanner',
    ]);
    assert.equal(result.body.data.runs[1].outcome, 'partial');
    assert.equal(result.body.data.runs[1].error, 'vendor timeout');
    assert.equal(result.body.data.runs[2].siteDomain, 'crst.com');
    assert.equal(result.body.data.runs[3].enqueueStatus, 'automation_disabled');
    assert.equal(result.body.data.runs[3].failureCode, 'automation_disabled');
  });

  it('rejects non-admin users', async () => {
    await assert.rejects(
      () => readAutomationRuns(request('operator')),
      (error) => error.statusCode === 403 && error.message === 'Admin access required'
    );
  });

  it('rejects invalid telemetry site cursors before querying', async () => {
    const result = await postTelemetryDailyRollup({}, {
      from: '2026-08-01',
      to: '2026-08-02',
      siteCursor: 'not-a-uuid',
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'Invalid siteCursor');
  });
});
