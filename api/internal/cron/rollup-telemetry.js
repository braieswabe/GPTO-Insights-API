import { loadEnv } from '../../../src/env.js';
import { runTelemetryRollupCronWindow } from '../../../src/services/telemetry-daily-rollup.js';

loadEnv();

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    const result = await runTelemetryRollupCronWindow({
      daysBack: Number(process.env.TELEMETRY_ROLLUP_CRON_DAYS_BACK || 2),
      maxSites: Number(process.env.TELEMETRY_ROLLUP_CRON_MAX_SITES || 40),
      maxRuns: Number(process.env.TELEMETRY_ROLLUP_CRON_MAX_RUNS || 120),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rollup: result }));
  } catch (error) {
    console.error('Cron telemetry rollup error:', error);
    res.writeHead(error.statusCode || 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: error?.message || 'Unknown error' }));
  }
}
