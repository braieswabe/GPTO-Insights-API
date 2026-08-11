import { loadEnv } from '../../../src/env.js';
import { processRefreshJobs } from '../../../src/services/dashboard.js';

loadEnv();

export default async function handler(req, res) {
  const authorization = req.headers.authorization || '';
  const cronSecret = process.env.CRON_SECRET;
  const internalToken = process.env.INTERNAL_API_TOKEN;
  const authorized = (cronSecret && authorization === `Bearer ${cronSecret}`)
    || (internalToken && authorization === `Bearer ${internalToken}`);
  if (!authorized) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  try {
    const result = await processRefreshJobs({
      limit: Number(process.env.DASHBOARD_REFRESH_WORKER_BATCH_SIZE || 1),
    });
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  } catch (error) {
    res.writeHead(error.statusCode || 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || String(error) }));
  }
}
