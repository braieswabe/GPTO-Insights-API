import { db } from '../db.js';
import { resolveDashboardTimeBounds } from '../dashboard-range.js';
import { SITE_SCORE_MODEL_VERSION, computeSiteScoreSnapshot } from '../lib/site-score-scoring.js';

const SERVER_CHECK_TIMEOUT_MS = 3500;

function dayStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function num(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function nullableNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function average(values) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function parseRanges(body = {}) {
  const input = Array.isArray(body.ranges) ? body.ranges : body.range ? [body.range] : [];
  const ranges = input.filter((range) => range === '7d' || range === '30d');
  return ranges.length ? ranges : ['7d', '30d'];
}

async function listSiteIds(sql, siteId = null) {
  if (siteId) {
    const rows = await sql`SELECT id FROM sites WHERE id = ${siteId}::uuid LIMIT 1`;
    return rows.map((row) => String(row.id));
  }
  const rows = await sql`SELECT id FROM sites WHERE status = 'active' ORDER BY domain ASC`;
  return rows.map((row) => String(row.id));
}

function extractLlmSources(rows) {
  const bySource = new Map();
  for (const row of rows) {
    const source = row.source || 'unknown';
    const payload = row.payload || {};
    const metrics = payload.metrics || {};
    const current = bySource.get(source) || {
      source,
      mentions: 0,
      citations: 0,
      citedPages: 0,
      aiSearchVolume: 0,
      impressions: 0,
      scoreSamples: [],
    };
    current.mentions += num(metrics.mentions);
    current.citations += num(metrics.citations);
    current.citedPages += num(metrics.citedPages);
    current.aiSearchVolume += num(metrics.aiSearchVolume);
    current.impressions += num(metrics.impressions);
    for (const item of Array.isArray(payload.platformBreakdown) ? payload.platformBreakdown : []) {
      const score = nullableNum(item?.score);
      if (score !== null) current.scoreSamples.push(score);
    }
    const directScore = nullableNum(payload.score);
    if (directScore !== null) current.scoreSamples.push(directScore);
    bySource.set(source, current);
  }
  return Array.from(bySource.values()).map(({ scoreSamples, ...source }) => ({
    ...source,
    score: scoreSamples.length ? Math.round(average(scoreSamples)) : null,
  }));
}

function metricAverage(events, key) {
  const avg = average(events.map((row) => nullableNum(row.metrics?.[key])).filter((value) => value !== null));
  return avg === null ? null : Math.max(0, Math.min(100, Math.round(avg * 100)));
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function aiBotBlockingSummary(robotsText) {
  const bots = ['GPTBot', 'ChatGPT-User', 'Google-Extended', 'PerplexityBot', 'CCBot'];
  const blocked = [];
  const groups = [];
  let current = null;
  for (const rawLine of String(robotsText || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) {
      current = null;
      continue;
    }
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'disallow' || key === 'allow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      current.rules.push({ directive: key, path: value });
    }
  }
  for (const bot of bots) {
    const botKey = bot.toLowerCase();
    const applicable = groups.filter((group) => group.agents.some((agent) => agent === '*' || agent === botKey));
    const disallowsRoot = applicable.some((group) =>
      group.rules.some((rule) => rule.directive === 'disallow' && (rule.path === '/' || rule.path === '/*'))
    );
    const allowsRoot = applicable.some((group) =>
      group.rules.some((rule) => rule.directive === 'allow' && (rule.path === '/' || rule.path === '/*'))
    );
    if (disallowsRoot && !allowsRoot) blocked.push(bot);
  }
  return blocked;
}

function sitemapUrlSummary(xml, origin) {
  const urls = Array.from(String(xml || '').matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi))
    .map((match) => match[1].trim())
    .filter(Boolean);
  const originRoot = String(origin || '').replace(/\/+$/, '');
  return {
    urlCount: urls.length,
    homepageIncluded: urls.some((url) => url.replace(/\/+$/, '') === originRoot),
    sampleUrls: urls.slice(0, 10),
  };
}

async function collectServerChecks(domain) {
  const origin = `https://${String(domain || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '')}`;
  const out = {
    origin,
    homepageStatus: null,
    robotsStatus: null,
    sitemapStatus: null,
    llmsTxtStatus: null,
    llmsTxtPresent: false,
    aiBotsBlocked: [],
    homepageCanonical: null,
    homepageCanonicalMatches: null,
    homepageFinalUrl: null,
    homepageRedirected: false,
    sitemapUrlCount: null,
    sitemapHomepageIncluded: null,
    sitemapSampleUrls: [],
  };
  if (!domain) return out;

  try {
    const homepage = await fetchWithTimeout(origin, { method: 'GET', redirect: 'follow' });
    out.homepageStatus = homepage.status;
    out.homepageFinalUrl = homepage.url || origin;
    out.homepageRedirected = Boolean(homepage.url && homepage.url.replace(/\/+$/, '') !== origin.replace(/\/+$/, ''));
    const html = await homepage.text().catch(() => '');
    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] || null;
    out.homepageCanonical = canonical;
    out.homepageCanonicalMatches = canonical ? canonical.replace(/\/+$/, '') === (homepage.url || origin).replace(/\/+$/, '') : null;
  } catch {
    out.homepageStatus = null;
  }

  try {
    const robots = await fetchWithTimeout(`${origin}/robots.txt`, { method: 'GET', redirect: 'follow' });
    out.robotsStatus = robots.status;
    const text = await robots.text().catch(() => '');
    out.aiBotsBlocked = aiBotBlockingSummary(text);
  } catch {
    out.robotsStatus = null;
  }

  try {
    const sitemap = await fetchWithTimeout(`${origin}/sitemap.xml`, { method: 'GET', redirect: 'follow' });
    out.sitemapStatus = sitemap.status;
    const text = await sitemap.text().catch(() => '');
    const summary = sitemapUrlSummary(text, origin);
    out.sitemapUrlCount = summary.urlCount;
    out.sitemapHomepageIncluded = summary.homepageIncluded;
    out.sitemapSampleUrls = summary.sampleUrls;
  } catch {
    out.sitemapStatus = null;
  }

  try {
    const llms = await fetchWithTimeout(`${origin}/llms.txt`, { method: 'GET', redirect: 'follow' });
    out.llmsTxtStatus = llms.status;
    out.llmsTxtPresent = llms.ok;
  } catch {
    out.llmsTxtStatus = null;
  }

  return out;
}

export async function materializeSiteScoreForSite(siteId, range = '7d') {
  const sql = db();
  const { start, end, rangeKey } = resolveDashboardTimeBounds(range === '30d' ? '30d' : '7d');
  const [site] = await sql`SELECT id, domain FROM sites WHERE id = ${siteId}::uuid LIMIT 1`;
  if (!site) throw new Error(`Site not found: ${siteId}`);

  const [authorityRows, coverageRows, readabilityRows, experienceRows, llmRows, schemaEvents, serverChecks] = await Promise.all([
    sql`
      SELECT authority_score
      FROM authority_signals
      WHERE site_id = ${siteId}::uuid AND window_end >= ${start} AND window_start <= ${end}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql`
      SELECT gaps, confidence
      FROM coverage_signals
      WHERE site_id = ${siteId}::uuid AND window_end >= ${start} AND window_start <= ${end}
      ORDER BY created_at DESC
      LIMIT 50
    `,
    sql`
      SELECT overall, confidence
      FROM readability_signals
      WHERE site_id = ${siteId}::uuid AND window_end >= ${start} AND window_start <= ${end}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql`
      SELECT score
      FROM experience_signals
      WHERE site_id = ${siteId}::uuid AND window_end >= ${start} AND window_start <= ${end}
      ORDER BY created_at DESC
      LIMIT 200
    `,
    sql`
      SELECT source, payload
      FROM llm_mentions_rollups_daily
      WHERE site_id = ${siteId}::uuid
        AND rollup_type = 'summary'
        AND day >= ${start}
        AND day <= ${end}
      ORDER BY day DESC
      LIMIT 200
    `,
    sql`
      SELECT metrics
      FROM telemetry_events
      WHERE site_id = ${siteId}::uuid AND timestamp >= ${start} AND timestamp <= ${end}
      LIMIT 500
    `,
    collectServerChecks(site.domain).catch((error) => ({ error: error?.message || String(error) })),
  ]);

  const payload = computeSiteScoreSnapshot({
    authorityScore: authorityRows[0]?.authority_score ?? null,
    readabilityScore: nullableNum(readabilityRows[0]?.overall?.score),
    experienceScores: experienceRows.map((row) => num(row.score)).filter((score) => score > 0),
    coverageConfidence: average(coverageRows.map((row) => num(row.confidence))),
    coverageGaps: coverageRows.flatMap((row) => (Array.isArray(row.gaps) ? row.gaps : [])),
    llmSources: extractLlmSources(llmRows),
    schemaCompletenessScore: metricAverage(schemaEvents, 'ai.schemaCompleteness'),
    schemaQualityScore: metricAverage(schemaEvents, 'ai.structuredDataQuality'),
    indexabilityScore: metricAverage(schemaEvents, 'ai.indexability'),
    extractabilityScore: metricAverage(schemaEvents, 'ai.extractability'),
    trustProofDensityScore: metricAverage(schemaEvents, 'ai.trustProofDensity'),
    internalLinkDensityScore: metricAverage(schemaEvents, 'ai.internalLinkDensity'),
    ctaClarityScore: metricAverage(schemaEvents, 'ai.ctaClarity'),
    schemaTemplateCoverageScore: metricAverage(schemaEvents, 'ai.schemaTemplateCoverage'),
    canonicalHealthScore: metricAverage(schemaEvents, 'ai.canonicalHealth'),
    imageAltCoverageScore: metricAverage(schemaEvents, 'ai.imageAltCoverage'),
    textDepthScore: metricAverage(schemaEvents, 'ai.textDepth'),
    headingStructureScore: metricAverage(schemaEvents, 'ai.headingStructure'),
    engagementQualityScore: metricAverage(schemaEvents, 'ai.engagementQuality'),
    technicalHealthScore: metricAverage(schemaEvents, 'ai.technicalHealth'),
    formFrictionScore: metricAverage(schemaEvents, 'ai.formFriction'),
    searchFrictionScore: metricAverage(schemaEvents, 'ai.searchFriction'),
    webVitalsScore: metricAverage(schemaEvents, 'ai.webVitals'),
    crawlReadinessScore: metricAverage(schemaEvents, 'ai.crawlReadiness'),
    telemetrySamples: schemaEvents.length,
    serverChecks,
    generatedAt: end.toISOString(),
  });

  await sql`
    DELETE FROM site_score_snapshots
    WHERE site_id = ${siteId}::uuid
      AND range_key = ${rangeKey}
      AND window_start = ${start}
      AND window_end = ${end}
      AND model_version = ${SITE_SCORE_MODEL_VERSION}
  `;
  const [inserted] = await sql`
    INSERT INTO site_score_snapshots (
      site_id, day, range_key, window_start, window_end, model_version,
      scores, source_scores, issue_distribution, evidence, updated_at
    )
    VALUES (
      ${siteId}::uuid,
      ${dayStart(end)},
      ${rangeKey},
      ${start},
      ${end},
      ${SITE_SCORE_MODEL_VERSION},
      ${sql.json(payload.scores)},
      ${sql.json(payload.sourceScores)},
      ${sql.json(payload.issueDistribution)},
      ${sql.json(payload.evidence)},
      now()
    )
    RETURNING id
  `;

  return {
    siteId,
    range: rangeKey,
    snapshotId: inserted?.id || null,
    status: payload.evidence?.dataCompleteness?.status || 'complete',
    scores: payload.scores,
    sourceScores: payload.sourceScores,
    serverChecks,
  };
}

export async function materializeSiteScores(body = {}) {
  const sql = db();
  const siteIds = await listSiteIds(sql, body.siteId || null);
  const ranges = parseRanges(body);
  const results = [];
  for (const siteId of siteIds) {
    for (const range of ranges) {
      try {
        results.push(await materializeSiteScoreForSite(siteId, range));
      } catch (error) {
        results.push({ siteId, range, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      siteIds,
      ranges,
      results,
    },
  };
}
