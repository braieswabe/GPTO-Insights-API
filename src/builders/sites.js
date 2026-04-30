import { db } from '../db.js';

export async function buildSitesList() {
  const sql = db();
  const rows = await sql`
    SELECT id, domain, status, created_at, updated_at
    FROM sites
    ORDER BY domain ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    status: r.status,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }));
}

export async function buildSiteConfig(siteId) {
  const sql = db();

  const [site] = await sql`
    SELECT id, domain, config_url, status, tenant_id, created_at, updated_at
    FROM sites
    WHERE id = ${siteId}::uuid
    LIMIT 1
  `;

  if (!site) {
    const error = new Error('Site not found');
    error.statusCode = 404;
    throw error;
  }

  const [activeConfig] = await sql`
    SELECT id, version, config_json, is_active, created_at
    FROM config_versions
    WHERE site_id = ${siteId}::uuid
      AND is_active = true
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const [subscription] = await sql`
    SELECT tier, status, current_period_start, current_period_end
    FROM subscriptions
    WHERE site_id = ${siteId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;

  return {
    site: {
      id: site.id,
      domain: site.domain,
      configUrl: site.config_url,
      status: site.status,
      tenantId: site.tenant_id,
      createdAt: site.created_at ? new Date(site.created_at).toISOString() : null,
      updatedAt: site.updated_at ? new Date(site.updated_at).toISOString() : null,
    },
    config: activeConfig
      ? {
          id: activeConfig.id,
          version: activeConfig.version,
          configJson: activeConfig.config_json,
          isActive: activeConfig.is_active,
          createdAt: activeConfig.created_at ? new Date(activeConfig.created_at).toISOString() : null,
        }
      : null,
    subscription: subscription
      ? {
          tier: subscription.tier,
          status: subscription.status,
          currentPeriodStart: subscription.current_period_start ? new Date(subscription.current_period_start).toISOString() : null,
          currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end).toISOString() : null,
        }
      : null,
  };
}
