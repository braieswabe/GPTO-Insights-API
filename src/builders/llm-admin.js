import { db } from '../db.js';
import {
  buildLlmMentionsCompetitors,
  buildLlmMentionsOverview,
  buildLlmMentionsPromptIntelligence,
  buildLlmMentionsSourceGap,
  buildLlmMentionsTrends,
} from './llm-mentions.js';
import { fetchLlmMentionsLive } from '../services/dataforseo.js';
import { buildCacheIdentity, upsertCacheRow } from '../cache.js';
import { ttlForModule } from '../types.js';

const DEFAULT_SOURCE = 'chat_gpt';
/**
 * Fallback DataForSEO defaults used only when neither the request nor the
 * tracked-prompt configuration provides explicit values.
 * The locations endpoint advertises this fallback so admin UIs can render it.
 */
const FALLBACK_LOCATION_CODE = 2840;
const FALLBACK_LANGUAGE_CODE = 'en';

async function loadDefaultLocaleForSite(siteId, source) {
  if (!siteId) return { locationCode: null, languageCode: null };
  const sql = db();
  const rows = source
    ? await sql`
        SELECT location_code, language_code
        FROM llm_mentions_tracked_prompts
        WHERE site_id = ${siteId}::uuid
          AND active = true
          AND source = ${source}
        ORDER BY created_at ASC
        LIMIT 1
      `
    : await sql`
        SELECT location_code, language_code
        FROM llm_mentions_tracked_prompts
        WHERE site_id = ${siteId}::uuid
          AND active = true
        ORDER BY created_at ASC
        LIMIT 1
      `;
  return {
    locationCode: rows[0]?.location_code ?? null,
    languageCode: rows[0]?.language_code ?? null,
  };
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function daysFromSearch(search) {
  const raw = Number(search.get('days') || search.get('autoRunWindowDays') || 7);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

function sourceFromSearch(search) {
  const source = search.get('source') || DEFAULT_SOURCE;
  return source === 'google_ai_overviews' ? 'google_ai_overviews' : 'chat_gpt';
}

function sourcesFromSearch(search) {
  const raw = search.get('sources');
  if (raw) {
    const sources = raw.split(',').map((value) => value.trim()).filter(Boolean);
    return sources.length ? sources : [sourceFromSearch(search)];
  }
  return [sourceFromSearch(search)];
}

export async function buildLegacyLlmMentionsResponse(search) {
  const siteId = search.get('siteId');
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }

  const sources = sourcesFromSearch(search);
  const source = sourceFromSearch(search);
  const overview = await buildLlmMentionsOverview({ siteId, days: daysFromSearch(search), sources });
  const defaults = await loadDefaultLocaleForSite(siteId, source);
  const requestedLocation = search.get('locationCode');
  const requestedLanguage = search.get('languageCode');
  return {
    siteId,
    siteDomain: overview.siteDomain,
    tier: null,
    filters: {
      locationCode: requestedLocation
        ? Number(requestedLocation)
        : defaults.locationCode ?? FALLBACK_LOCATION_CODE,
      languageCode: requestedLanguage || defaults.languageCode || FALLBACK_LANGUAGE_CODE,
      source,
    },
    summary: overview.summary,
    cache: { aggregated: true, topPages: true, topDomains: true, search: true },
    access: { llmMentions: true, llmMentionsCompetitors: true, llmMentionsSearch: true },
    availability: { supported: true },
    data: {
      aggregated: overview,
      topPages: overview.summary?.topPages || [],
      topDomains: overview.summary?.topDomains || [],
      search: overview.summary?.searchExamples || [],
    },
    aiVisibility: overview.aiVisibility || null,
    latestSnapshotRuns: overview.snapshots || [],
  };
}

export async function buildLlmEndpointResponse(endpoint, search) {
  const siteId = search.get('siteId');
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }

  const source = sourceFromSearch(search);
  const days = daysFromSearch(search);
  if (endpoint === 'trends') {
    const result = await buildLlmMentionsTrends({
      siteId,
      source,
      days,
      rollupType: search.get('rollupType') || 'summary',
    });
    const defaults = await loadDefaultLocaleForSite(siteId, source);
    const requestedLocation = search.get('locationCode');
    const requestedLanguage = search.get('languageCode');
    return {
      siteId,
      source,
      locationCode: requestedLocation
        ? Number(requestedLocation)
        : defaults.locationCode ?? FALLBACK_LOCATION_CODE,
      languageCode: requestedLanguage || defaults.languageCode || FALLBACK_LANGUAGE_CODE,
      rollupType: result.rollupType,
      points: result.trend || [],
    };
  }
  if (endpoint === 'competitors') return buildLlmMentionsCompetitors({ siteId, source });
  if (endpoint === 'prompt-intelligence') return buildLlmMentionsPromptIntelligence({ siteId, source });
  if (endpoint === 'source-gap') return buildLlmMentionsSourceGap({ siteId, source });

  const legacy = await buildLegacyLlmMentionsResponse(search);
  if (endpoint === 'aggregated') return legacy.data.aggregated;
  if (endpoint === 'top-pages') return { siteId, source, rows: legacy.summary?.topPages || [] };
  if (endpoint === 'top-domains') return { siteId, source, rows: legacy.summary?.topDomains || [] };
  if (endpoint === 'search') return { siteId, source, rows: legacy.summary?.searchExamples || [] };
  if (endpoint === 'locations') {
    const sql = db();
    const rows = await sql`
      SELECT DISTINCT location_code, language_code
      FROM llm_mentions_tracked_prompts
      WHERE site_id = ${siteId}::uuid
        AND active = true
        AND location_code IS NOT NULL
        AND language_code IS NOT NULL
      ORDER BY location_code ASC
    `;
    const locations = rows.length
      ? rows.map((r) => ({
          locationCode: r.location_code,
          languageCode: r.language_code,
          label: `${r.location_code} / ${r.language_code}`,
        }))
      : [{ locationCode: FALLBACK_LOCATION_CODE, languageCode: FALLBACK_LANGUAGE_CODE, label: 'United States / English' }];
    return { siteId, source, locations };
  }
  return legacy;
}

export async function listTrackedPrompts(search) {
  const siteId = search.get('siteId');
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }
  const sql = db();
  const rows = await sql`
    SELECT id, site_id, label, query, bucket, intent, priority, active,
           location_code, language_code, source, seeded, created_at, updated_at
    FROM llm_mentions_tracked_prompts
    WHERE site_id = ${siteId}::uuid
    ORDER BY created_at ASC
  `;
  return {
    siteId,
    data: rows.map(promptRow),
    prompts: rows.map(promptRow),
  };
}

export async function createTrackedPrompt(body) {
  const siteId = body?.siteId;
  const query = String(body?.query || body?.label || '').trim();
  if (!siteId || !query) {
    const error = new Error('siteId and query are required');
    error.statusCode = 400;
    throw error;
  }
  const sql = db();
  const rows = await sql`
    INSERT INTO llm_mentions_tracked_prompts (
      site_id, label, query, bucket, intent, priority, active,
      location_code, language_code, source, seeded, created_at, updated_at
    )
    VALUES (
      ${siteId}::uuid,
      ${body.label || query},
      ${query},
      ${body.bucket || 'tracked'},
      ${body.intent || 'tracked'},
      ${body.priority || 'medium'},
      ${body.active !== false},
      ${Number(body.locationCode || FALLBACK_LOCATION_CODE)},
      ${body.languageCode || FALLBACK_LANGUAGE_CODE},
      ${body.source || DEFAULT_SOURCE},
      ${body.seeded === true},
      now(),
      now()
    )
    RETURNING *
  `;
  return { data: promptRow(rows[0]), prompt: promptRow(rows[0]) };
}

export async function updateTrackedPrompt(id, body) {
  const sql = db();
  const rows = await sql`
    UPDATE llm_mentions_tracked_prompts
    SET label = COALESCE(${body.label || null}, label),
        query = COALESCE(${body.query || null}, query),
        bucket = COALESCE(${body.bucket || null}, bucket),
        intent = COALESCE(${body.intent || null}, intent),
        priority = COALESCE(${body.priority || null}, priority),
        active = COALESCE(${typeof body.active === 'boolean' ? body.active : null}, active),
        location_code = COALESCE(${body.locationCode ? Number(body.locationCode) : null}, location_code),
        language_code = COALESCE(${body.languageCode || null}, language_code),
        source = COALESCE(${body.source || null}, source),
        updated_at = now()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  if (!rows[0]) {
    const error = new Error('Tracked prompt not found');
    error.statusCode = 404;
    throw error;
  }
  return { data: promptRow(rows[0]), prompt: promptRow(rows[0]) };
}

export async function deleteTrackedPrompt(id) {
  const sql = db();
  await sql`DELETE FROM llm_mentions_tracked_prompts WHERE id = ${id}::uuid`;
  return { ok: true, data: { id } };
}

export async function getTrackedPromptSiteId(id) {
  const sql = db();
  const rows = await sql`
    SELECT site_id
    FROM llm_mentions_tracked_prompts
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  return rows[0]?.site_id || null;
}

export async function listRawSnapshots(search) {
  const sql = db();
  const snapshotId = search.get('snapshotId');
  if (snapshotId) {
    const rows = await sql`
      SELECT *
      FROM llm_mentions_snapshots
      WHERE id = ${snapshotId}::uuid
      LIMIT 1
    `;
    return { snapshot: rows[0] ? snapshotRow(rows[0]) : null };
  }

  const siteId = search.get('siteId');
  const limit = Math.max(1, Math.min(Number(search.get('limit') || 50), 100));
  const rows = siteId
    ? await sql`
        SELECT id, site_id, endpoint, target_key, request_params, response_data,
               status, source, source_context, fetched_at, expires_at, created_at
        FROM llm_mentions_snapshots
        WHERE site_id = ${siteId}::uuid
        ORDER BY fetched_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT id, site_id, endpoint, target_key, request_params, response_data,
               status, source, source_context, fetched_at, expires_at, created_at
        FROM llm_mentions_snapshots
        ORDER BY fetched_at DESC
        LIMIT ${limit}
      `;
  const data = rows.map(snapshotRow);
  return { data, snapshots: data };
}

function snapshotRow(row) {
  return {
    id: row.id,
    snapshotId: row.id,
    siteId: row.site_id,
    endpoint: row.endpoint,
    targetKey: row.target_key,
    requestParams: row.request_params,
    responseData: row.response_data,
    status: row.status,
    source: row.source,
    sourceContext: row.source_context,
    fetchedAt: iso(row.fetched_at),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

export async function runPromptRefresh(search) {
  const siteId = search.get('siteId');
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }
  const source = sourceFromSearch(search);
  const days = daysFromSearch(search);
  const portalScope = search.get('portal') === 'admin' ? 'admin' : search.get('portal') === 'customer' ? 'customer' : 'employee';
  const sources = [source];
  const overview = await buildLlmMentionsOverview({ siteId, days, sources });

  let refreshed = false;
  let cacheKey = null;
  try {
    const identity = buildCacheIdentity({
      portalScope,
      moduleKey: 'llm_mentions_overview',
      siteId,
      rangeKey: `${days}d`,
      params: { days, sources },
    });
    await upsertCacheRow(identity, overview, { ttlSeconds: ttlForModule('llm_mentions_overview') });
    refreshed = true;
    cacheKey = `${portalScope}:llm_mentions_overview:${siteId}:${days}d:${identity.paramsHash}`;
  } catch (error) {
    console.error('runPromptRefresh cache write failed (non-fatal):', error?.message || error);
  }

  return {
    ok: true,
    siteId,
    source,
    refreshed,
    cacheKey,
    refreshedAt: new Date().toISOString(),
    message: refreshed
      ? 'Gateway cache refreshed and primed with the latest LLM Mentions overview.'
      : 'Gateway cache refresh attempted but could not be persisted; payload returned from the live build.',
    summary: overview.summary,
    aiVisibility: overview.aiVisibility,
  };
}

export async function runRawRequest(body = {}, search = new URLSearchParams()) {
  const endpoint = body.endpoint || search.get('endpoint') || 'aggregated_metrics';
  const siteId = body.siteId || search.get('siteId') || null;
  const source = body.source || body.payload?.platform || sourceFromSearch(search);

  if (endpoint === 'locations_and_languages') {
    return {
      endpoint,
      siteId,
      fromCache: true,
      fetchedAt: new Date().toISOString(),
      data: {
        status_code: 20000,
        status_message: 'Ok.',
        tasks_error: 0,
        tasks: [
          {
            status_code: 20000,
            status_message: 'Ok.',
            result: [
              { location_code: FALLBACK_LOCATION_CODE, location_name: 'United States', language_code: FALLBACK_LANGUAGE_CODE, language_name: 'English' },
            ],
          },
        ],
      },
    };
  }

  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }

  const live = await fetchLlmMentionsLive(endpoint, body.payload).catch((error) => ({ error }));
  if (live && !live.error) {
    await persistRawSnapshot({ siteId, endpoint, body, responseData: live, source }).catch(() => undefined);
    return {
      endpoint,
      siteId,
      source,
      fromCache: false,
      fetchedAt: new Date().toISOString(),
      data: live,
      payload: body.payload || null,
    };
  }

  const params = new URLSearchParams(search.toString());
  params.set('siteId', siteId);
  params.set('source', source);
  const legacy = await buildLegacyLlmMentionsResponse(params);
  const result =
    endpoint === 'top_pages'
      ? legacy.summary?.topPages || []
      : endpoint === 'top_domains'
        ? legacy.summary?.topDomains || []
        : endpoint === 'search'
          ? legacy.summary?.searchExamples || []
          : [legacy.summary || {}];

  return {
    endpoint,
    siteId,
    source,
    fromCache: true,
    fetchedAt: new Date().toISOString(),
    data: {
      status_code: 20000,
      status_message: 'Served from persisted Insights Gateway data.',
      tasks_error: 0,
      tasks: [
        {
          status_code: 20000,
          status_message: 'Ok.',
          result,
        },
      ],
    },
    payload: body.payload || null,
  };
}

async function persistRawSnapshot({ siteId, endpoint, body, responseData, source }) {
  const sql = db();
  await sql`
    INSERT INTO llm_mentions_snapshots (
      site_id, endpoint, target_key, request_params, response_data,
      status, source, source_context, fetched_at, expires_at, created_at
    )
    VALUES (
      ${siteId}::uuid,
      ${endpoint},
      ${body.targetType || null},
      ${sql.json(body)},
      ${sql.json(responseData)},
      'success',
      ${source || DEFAULT_SOURCE},
      ${body.sourceContext || 'manual'},
      now(),
      now() + interval '6 hours',
      now()
    )
  `;
}

function promptRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    siteId: row.site_id,
    label: row.label,
    query: row.query,
    bucket: row.bucket,
    intent: row.intent,
    priority: row.priority,
    active: row.active,
    locationCode: row.location_code,
    languageCode: row.language_code,
    source: row.source,
    seeded: row.seeded,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
