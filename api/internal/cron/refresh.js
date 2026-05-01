import { loadEnv } from '../../../src/env.js';
import { processRefreshJobs } from '../../../src/services/dashboard.js';

loadEnv();

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    const result = await processRefreshJobs({ limit: 5 });
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  } catch (error) {
    console.error('Cron refresh error:', error);
    res.writeHead(error.statusCode || 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: error?.message || 'Unknown error' }));
  }
}
