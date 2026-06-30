import { db } from '../db.js';
import { computeCompetitorScoreSnapshot, COMPETITOR_SCORE_MODEL_VERSION, normalizeCompetitorDomain } from '../lib/competitor-score-scoring.js';

const SERVER_CHECK_TIMEOUT_MS = 3500;

function dayStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function resolveWindow(rangeKey, now = new Date()) {
  const end = new Date(now);
  const start = new Date(end);
  start.setDate(end.getDate() - (rangeKey === '90d' ? 90 : rangeKey === '30d' ? 30 : 7));
  return { start, end };
}

function parseRanges(body = {}) {
  const input = Array.isArray(body.ranges) ? body.ranges : body.range ? [body.range] : [];
  const ranges = input.filter((range) => range === '7d' || range === '30d' || range === '90d');
  return ranges.length ? ranges : ['7d', '30d', '90d'];
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
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function average(values = []) {
  const clean = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
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

function extractCrawlFacts(html) {
  const cleanText = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || null;
  const description =
    String(html || '').match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)?.[1]?.trim() ||
    String(html || '').match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i)?.[1]?.trim() ||
    null;
  const schemaTypes = Array.from(String(html || '').matchAll(/"@type"\s*:\s*"([^"]+)"/g)).map((match) => match[1]).slice(0, 20);
  return {
    title,
    description,
    wordCount: cleanText ? cleanText.split(/\s+/).length : 0,
    headingCount: (String(html || '').match(/<h[1-6][^>]*>/gi) || []).length,
    linkCount: (String(html || '').match(/<a\s/gi) || []).length,
    schemaTypes: Array.from(new Set(schemaTypes)),
  };
}

async function collectPublicChecks(domain) {
  const origin = `https://${normalizeCompetitorDomain(domain)}`;
  const out = {
    origin,
    homepageStatus: null,
    robotsStatus: null,
    sitemapStatus: null,
    llmsTxtStatus: null,
    homepageFinalUrl: null,
    homepageRedirected: false,
    homepageCanonical: null,
    homepageCanonicalMatches: null,
    aiBotsBlocked: [],
    llmsTxtPresent: false,
    sitemapUrlCount: null,
    sitemapHomepageIncluded: null,
    sitemapSampleUrls: [],
  };
  let crawl = null;
  try {
    const homepage = await fetchWithTimeout(origin, { redirect: 'follow', headers: { 'user-agent': 'GPTOBot/1.0 competitor assessment' } });
    out.homepageStatus = homepage.status;
    out.homepageFinalUrl = homepage.url || origin;
    out.homepageRedirected = out.homepageFinalUrl.replace(/\/+$/, '') !== origin.replace(/\/+$/, '');
    const html = await homepage.text().catch(() => '');
    crawl = extractCrawlFacts(html);
    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i)?.[1] || null;
    out.homepageCanonical = canonical;
    out.homepageCanonicalMatches = canonical ? canonical.replace(/\/+$/, '') === out.homepageFinalUrl.replace(/\/+$/, '') : null;
  } catch (error) {
    out.homepageError = error?.message || String(error);
  }
  try {
    const robots = await fetchWithTimeout(`${origin}/robots.txt`);
    out.robotsStatus = robots.status;
    const text = await robots.text().catch(() => '');
    out.aiBotsBlocked = aiBotBlockingSummary(text);
  } catch (error) {
    out.robotsError = error?.message || String(error);
  }
  try {
    const sitemap = await fetchWithTimeout(`${origin}/sitemap.xml`);
    out.sitemapStatus = sitemap.status;
    const text = await sitemap.text().catch(() => '');
    const summary = sitemapUrlSummary(text, origin);
    out.sitemapUrlCount = summary.urlCount;
    out.sitemapHomepageIncluded = summary.homepageIncluded;
    out.sitemapSampleUrls = summary.sampleUrls;
  } catch (error) {
    out.sitemapError = error?.message || String(error);
  }
  try {
    const llms = await fetchWithTimeout(`${origin}/llms.txt`);
    out.llmsTxtStatus = llms.status;
    out.llmsTxtPresent = llms.ok;
  } catch (error) {
    out.llmsTxtError = error?.message || String(error);
  }
  return { serverChecks: out, crawl };
}

function targetMatches(rowTarget, domain) {
  const target = normalizeCompetitorDomain(rowTarget || '');
  const normalized = normalizeCompetitorDomain(domain);
  return target === normalized || target.endsWith(`.${normalized}`) || normalized.endsWith(`.${target}`);
}

function extractLlmSources(rollups, domain) {
  const bySource = new Map();
  for (const row of rollups) {
    const source = row.source || 'unknown';
    const payload = row.payload || {};
    const comparison = Array.isArray(payload.comparison) ? payload.comparison : [];
    const match = comparison.find((item) => targetMatches(item?.target || item?.domain, domain));
    if (!match) continue;
    const current = bySource.get(source) || {
      source,
      mentions: 0,
      citations: 0,
      citedPages: 0,
      aiSearchVolume: 0,
      impressions: 0,
      shareSamples: [],
      scoreSamples: [],
    };
    current.mentions += num(match.mentions);
    current.citations += num(match.citations);
    current.citedPages += num(match.citedPages);
    current.aiSearchVolume += num(match.aiSearchVolume);
    current.impressions += num(match.impressions);
    const share = nullableNum(match.shareOfVoice);
    if (share !== null) current.shareSamples.push(share);
    const score = nullableNum(match.score);
    if (score !== null) current.scoreSamples.push(score);
    bySource.set(source, current);
  }
  return Array.from(bySource.values()).map(({ shareSamples, scoreSamples, ...source }) => ({
    ...source,
    shareOfVoice: average(shareSamples),
    score: scoreSamples.length ? Math.round(average(scoreSamples)) : null,
  }));
}

function promptMentionsDomain(row, domain) {
  const cited = Array.isArray(row.cited_domains) ? row.cited_domains : [];
  const retrieved = Array.isArray(row.retrieved_domains) ? row.retrieved_domains : [];
  return [...cited, ...retrieved].some((candidate) => targetMatches(candidate, domain));
}

async function listSiteIds(sql, siteId = null) {
  if (siteId) {
    const rows = await sql`SELECT id FROM sites WHERE id = ${siteId}::uuid LIMIT 1`;
    return rows.map((row) => String(row.id));
  }
  const rows = await sql`SELECT id FROM sites WHERE status = 'active' ORDER BY domain ASC`;
  return rows.map((row) => String(row.id));
}

async function listCompetitors(sql, siteId, competitorId = null) {
  if (competitorId) {
    return await sql`
      SELECT id, site_id, domain, name, color_key
      FROM competitors
      WHERE site_id = ${siteId}::uuid AND id = ${competitorId}::uuid AND status <> 'paused'
      ORDER BY created_at ASC
    `;
  }
  return await sql`
    SELECT id, site_id, domain, name, color_key
    FROM competitors
    WHERE site_id = ${siteId}::uuid AND status <> 'paused'
    ORDER BY created_at ASC
    LIMIT 4
  `;
}

async function materializeCompetitorForRange(sql, competitor, rangeKey, options = {}) {
  const { start, end } = resolveWindow(rangeKey, options.now || new Date());
  const [rollups, prompts, publicChecks] = await Promise.all([
    sql`
      SELECT source, payload
      FROM llm_mentions_rollups_daily
      WHERE site_id = ${competitor.site_id}::uuid
        AND rollup_type = 'competitors'
        AND day >= ${start}
        AND day <= ${end}
      ORDER BY day DESC
      LIMIT 500
    `,
    sql`
      SELECT question, cited_domains, retrieved_domains, brand_entities, fan_out_queries,
             outcome, mentions, ai_search_volume, impressions, source, fetched_at
      FROM llm_mentions_prompt_observations
      WHERE site_id = ${competitor.site_id}::uuid
        AND fetched_at >= ${start}
        AND fetched_at <= ${end}
      ORDER BY fetched_at DESC
      LIMIT 200
    `,
    options.skipCrawl ? Promise.resolve({ serverChecks: null, crawl: null }) : collectPublicChecks(competitor.domain),
  ]);
  const topPrompts = prompts
    .filter((row) => promptMentionsDomain(row, competitor.domain))
    .slice(0, 20)
    .map((row) => ({
      question: row.question,
      outcome: row.outcome,
      aiSearchVolume: row.ai_search_volume,
      impressions: row.impressions,
      citedDomains: row.cited_domains || [],
      retrievedDomains: row.retrieved_domains || [],
      source: row.source,
      fetchedAt: row.fetched_at,
    }));
  const payload = computeCompetitorScoreSnapshot({
    domain: competitor.domain,
    displayName: competitor.name,
    llmSources: extractLlmSources(rollups, competitor.domain),
    serverChecks: publicChecks.serverChecks,
    crawl: publicChecks.crawl,
    websiteAudience: null,
    topCitedPages: [],
    topPrompts,
    generatedAt: end.toISOString(),
  });

  if (options.dryRun) {
    return {
      siteId: competitor.site_id,
      competitorId: competitor.id,
      domain: competitor.domain,
      range: rangeKey,
      status: payload.status,
      scores: payload.scores,
      dryRun: true,
    };
  }

  await sql`
    DELETE FROM competitor_score_snapshots
    WHERE site_id = ${competitor.site_id}::uuid
      AND competitor_id = ${competitor.id}::uuid
      AND range_key = ${rangeKey}
      AND window_start = ${start}
      AND window_end = ${end}
      AND model_version = ${COMPETITOR_SCORE_MODEL_VERSION}
  `;
  const [inserted] = await sql`
    INSERT INTO competitor_score_snapshots (
      site_id, competitor_id, competitor_domain, day, range_key, window_start, window_end, model_version,
      scores, metrics, source_scores, issue_distribution, evidence, freshness, missing_data, updated_at
    )
    VALUES (
      ${competitor.site_id}::uuid,
      ${competitor.id}::uuid,
      ${normalizeCompetitorDomain(competitor.domain)},
      ${dayStart(end)},
      ${rangeKey},
      ${start},
      ${end},
      ${COMPETITOR_SCORE_MODEL_VERSION},
      ${sql.json(payload.scores)},
      ${sql.json(payload.metrics)},
      ${sql.json(payload.sourceScores)},
      ${sql.json(payload.issueDistribution)},
      ${sql.json(payload.evidence)},
      ${sql.json(payload.freshness)},
      ${sql.json(payload.missingData)},
      now()
    )
    RETURNING id
  `;
  await sql`
    UPDATE competitors
    SET last_assessed_at = now(), last_error = NULL, updated_at = now()
    WHERE id = ${competitor.id}::uuid
  `;
  return {
    siteId: competitor.site_id,
    competitorId: competitor.id,
    domain: competitor.domain,
    range: rangeKey,
    snapshotId: inserted?.id || null,
    status: payload.status,
    scores: payload.scores,
    missingData: payload.missingData,
  };
}

export async function materializeCompetitorScores(body = {}) {
  const sql = db();
  const siteIds = await listSiteIds(sql, body.siteId || null);
  const ranges = parseRanges(body);
  const results = [];
  for (const siteId of siteIds) {
    const competitors = await listCompetitors(sql, siteId, body.competitorId || null);
    for (const competitor of competitors) {
      for (const range of ranges) {
        try {
          results.push(await materializeCompetitorForRange(sql, competitor, range, {
            dryRun: body.dryRun === true,
            skipCrawl: body.skipCrawl === true,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await sql`
            UPDATE competitors
            SET status = 'failed', last_error = ${message}, updated_at = now()
            WHERE id = ${competitor.id}::uuid
          `.catch(() => []);
          results.push({ siteId, competitorId: competitor.id, domain: competitor.domain, range, status: 'failed', error: message });
        }
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
