import { db } from './db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let dbReader = db;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function setAccessDbReaderForTests(reader) {
  dbReader = reader || db;
}

function validateOptionalUuid(value, label) {
  if (value == null || value === '') return null;
  if (!isUuid(value)) throw badRequest(`Invalid ${label}`);
  return value;
}

export function requireInternalAuth(request) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return { ok: false, status: 500, error: 'INTERNAL_API_TOKEN is not configured' };
  }
  const actual = request.headers.authorization || '';
  if (actual !== `Bearer ${expected}`) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

export function getUserContext(request) {
  return {
    userId: request.headers['x-gpto-user-id'] || null,
    role: request.headers['x-gpto-user-role'] || 'employee',
    tenantId: request.headers['x-gpto-tenant-id'] || null,
  };
}

export async function assertSiteAccess({ siteId, portalScope, user }) {
  const normalizedSiteId = validateOptionalUuid(siteId, 'siteId');
  const normalizedUserId = validateOptionalUuid(user?.userId, 'x-gpto-user-id header');
  const normalizedTenantId = validateOptionalUuid(user?.tenantId, 'x-gpto-tenant-id header');
  const role = user?.role || 'employee';

  if (!normalizedSiteId) {
    if (role === 'client' || (portalScope === 'customer' && !['admin', 'operator'].includes(role))) {
      const error = new Error('siteId is required for customer scoped reads');
      error.statusCode = 400;
      throw error;
    }
    return;
  }

  if (['admin', 'operator', 'employee', 'viewer'].includes(role) && portalScope !== 'customer') {
    return;
  }

  const sql = dbReader();
  const rows = await sql`
    SELECT s.id
    FROM sites s
    LEFT JOIN user_site_access usa
      ON usa.site_id = s.id
     AND usa.user_id = ${normalizedUserId}::uuid
    WHERE s.id = ${normalizedSiteId}::uuid
      AND (
        usa.id IS NOT NULL
        OR (${normalizedTenantId}::uuid IS NOT NULL AND s.tenant_id = ${normalizedTenantId}::uuid)
      )
    LIMIT 1
  `;
  if (!rows[0]) {
    const error = new Error('Access denied to this site');
    error.statusCode = 403;
    throw error;
  }
}
