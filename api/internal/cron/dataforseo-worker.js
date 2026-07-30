import { loadEnv } from '../../../src/env.js';
import {
  dataForSeoAutomationEnabled,
  runDataForSeoAutomationWorker,
} from '../../../src/services/dataforseo-automation.js';

loadEnv();

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  if (!dataForSeoAutomationEnabled()) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, skipped: true, reason: 'automation_disabled' }));
    return;
  }
  try {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(await runDataForSeoAutomationWorker()));
  } catch (error) {
    res.writeHead(error.statusCode || 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message || String(error) }));
  }
}
