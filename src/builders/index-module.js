import { db } from '../db.js';

export async function buildIndex(input) {
  const { siteId, rangeKey } = input;
  const sql = db();

  const sites = siteId
    ? await sql`SELECT id, domain, status, created_at, updated_at FROM sites WHERE id = ${siteId}::uuid`
    : await sql`SELECT id, domain, status, created_at, updated_at FROM sites ORDER BY domain ASC`;

  return {
    range: rangeKey,
    dashboards: sites.map((s) => ({
      id: s.id,
      name: s.domain,
      detailType: 'overview',
      status: s.status === 'active' ? 'Active' : s.status === 'pending' ? 'Waiting' : 'Active',
      dataConnected: true,
      lastUpdate: s.updated_at ? new Date(s.updated_at).toISOString() : null,
      confidence: 'Medium',
    })),
    llmAiVisibility: null,
  };
}
