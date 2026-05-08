import { createHash } from 'node:crypto';
import { db } from './db.js';
import { EMPTY_SITE_UUID, MODEL_VERSION } from './types.js';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] === undefined) return acc;
        acc[key] = stableValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function hashParams(params = {}) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(params)))
    .digest('hex');
}

export function buildCacheIdentity({ portalScope, moduleKey, siteId = null, rangeKey, params = {} }) {
  return {
    portalScope,
    moduleKey,
    siteId,
    rangeKey,
    params,
    paramsHash: hashParams(params),
    modelVersion: MODEL_VERSION,
  };
}

export function isCacheStale(row) {
  if (!row) return true;
  if (!row.expires_at) return false;
  return new Date(row.expires_at).getTime() <= Date.now();
}

export function serializeCacheRow(row) {
  if (!row) return null;
  return {
    payload: row.payload,
    metadata: {
      status: row.status,
      generatedAt: row.generated_at ? new Date(row.generated_at).toISOString() : null,
      sourceWatermarkAt: row.source_watermark_at ? new Date(row.source_watermark_at).toISOString() : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      stale: isCacheStale(row),
      error: row.error || null,
      modelVersion: row.model_version,
    },
  };
}

export async function getCacheRow(identity) {
  const sql = db();
  const rows = await sql`
    SELECT
      id,
      site_id,
      portal_scope,
      module_key,
      range_key,
      params_hash,
      payload,
      status,
      generated_at,
      source_watermark_at,
      expires_at,
      error,
      model_version,
      created_at,
      updated_at
    FROM dashboard_api_cache
    WHERE portal_scope = ${identity.portalScope}
      AND module_key = ${identity.moduleKey}
      AND COALESCE(site_id, ${EMPTY_SITE_UUID}::uuid) = COALESCE(${identity.siteId}::uuid, ${EMPTY_SITE_UUID}::uuid)
      AND range_key = ${identity.rangeKey}
      AND params_hash = ${identity.paramsHash}
      AND model_version = ${identity.modelVersion}
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function upsertCacheRow(identity, payload, options = {}) {
  const sql = db();
  const generatedAt = options.generatedAt || new Date();
  const sourceWatermarkAt = options.sourceWatermarkAt || null;
  const ttlSeconds = options.ttlSeconds ?? 300;
  const expiresAt = options.expiresAt || new Date(generatedAt.getTime() + ttlSeconds * 1000);

  const siteIdValue = identity.siteId || null;
  return sql.begin(async (tx) => {
    await tx`
      DELETE FROM dashboard_api_cache
      WHERE portal_scope = ${identity.portalScope}
        AND module_key = ${identity.moduleKey}
        AND COALESCE(site_id, ${EMPTY_SITE_UUID}::uuid) = COALESCE(${siteIdValue}::uuid, ${EMPTY_SITE_UUID}::uuid)
        AND range_key = ${identity.rangeKey}
        AND params_hash = ${identity.paramsHash}
        AND model_version = ${identity.modelVersion}
    `;
    const rows = await tx`
      INSERT INTO dashboard_api_cache (
        site_id, portal_scope, module_key, range_key, params_hash,
        payload, status, generated_at, source_watermark_at, expires_at,
        error, model_version, updated_at
      )
      VALUES (
        ${siteIdValue}, ${identity.portalScope}, ${identity.moduleKey},
        ${identity.rangeKey}, ${identity.paramsHash}, ${sql.json(payload)},
        ${options.status || 'ready'}, ${generatedAt}, ${sourceWatermarkAt},
        ${expiresAt}, ${options.error || null}, ${identity.modelVersion}, now()
      )
      RETURNING
        id,
        site_id,
        portal_scope,
        module_key,
        range_key,
        params_hash,
        payload,
        status,
        generated_at,
        source_watermark_at,
        expires_at,
        error,
        model_version,
        created_at,
        updated_at
    `;
    return rows[0];
  });
}
