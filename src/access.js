import { db } from './db.js';

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
  if (!siteId) {
    if (portalScope === 'customer' || user.role === 'client') {
      const error = new Error('siteId is required for customer scoped reads');
      error.statusCode = 400;
      throw error;
    }
    return;
  }

  if (['admin', 'operator', 'employee', 'viewer'].includes(user.role) && portalScope !== 'customer') {
    return;
  }

  const sql = db();
  const rows = await sql`
    SELECT s.id
    FROM sites s
    LEFT JOIN user_site_access usa
      ON usa.site_id = s.id
     AND usa.user_id = ${user.userId}::uuid
    WHERE s.id = ${siteId}::uuid
      AND (
        usa.id IS NOT NULL
        OR (${user.tenantId}::uuid IS NOT NULL AND s.tenant_id = ${user.tenantId}::uuid)
      )
    LIMIT 1
  `;
  if (!rows[0]) {
    const error = new Error('Access denied to this site');
    error.statusCode = 403;
    throw error;
  }
}
