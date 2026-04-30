import { loadEnv } from '../../../src/env.js';
import { claimRefreshJobs, completeRefreshJob, enqueueRefreshJob } from '../../../src/jobs.js';
import { buildCacheIdentity, getCacheRow, isCacheStale, upsertCacheRow } from '../../../src/cache.js';
import { buildModule, buildLlmMentionsOverview } from '../../../src/builders/index.js';
import { buildSitesList } from '../../../src/builders/sites.js';
import { DASHBOARD_MODULES, ttlForModule } from '../../../src/types.js';

loadEnv();

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    const sites = await buildSitesList();
    const modulesToCheck = ['overview', 'telemetry', 'authority', 'executive_summary'];
    let enqueued = 0;

    for (const site of sites.slice(0, 10)) {
      for (const moduleKey of modulesToCheck) {
        const identity = buildCacheIdentity({
          portalScope: 'employee',
          moduleKey,
          siteId: site.id,
          rangeKey: '7d',
          params: { portalScope: 'employee' },
        });
        const row = await getCacheRow(identity);
        if (!row || isCacheStale(row)) {
          const result = await enqueueRefreshJob(identity);
          if (result.queued) enqueued++;
        }
      }
    }

    const jobs = await claimRefreshJobs(5);
    const results = [];

    for (const job of jobs) {
      try {
        const identity = {
          portalScope: job.portal_scope,
          moduleKey: job.module_key,
          siteId: job.site_id,
          rangeKey: job.range_key,
          params: job.params || {},
          paramsHash: job.params_hash,
          modelVersion: job.model_version,
        };
        const payload =
          job.module_key === 'llm_mentions_overview'
            ? await buildLlmMentionsOverview({
                siteId: job.site_id,
                days: Number(job.params?.days || 7),
                sources: Array.isArray(job.params?.sources) ? job.params.sources : ['chat_gpt', 'google_ai_overviews'],
              })
            : await buildModule(job.module_key, {
                siteId: job.site_id,
                rangeKey: job.range_key,
                portalScope: job.portal_scope,
              });

        await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule(job.module_key) });
        await completeRefreshJob(job.id, { ok: true });
        results.push({ jobId: job.id, moduleKey: job.module_key, ok: true });
      } catch (error) {
        await completeRefreshJob(job.id, { ok: false, error: error?.message || String(error) });
        results.push({ jobId: job.id, moduleKey: job.module_key, ok: false, error: error?.message });
      }
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, enqueued, claimed: jobs.length, results }));
  } catch (error) {
    console.error('Cron refresh error:', error);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: error?.message || 'Unknown error' }));
  }
}
