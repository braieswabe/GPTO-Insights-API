import { db } from '../db.js';

function inferRangeKey(start, end) {
  const days = Math.round((new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 8) return '7d';
  if (days >= 29 && days <= 31) return '30d';
  return null;
}

export async function loadLatestSiteScoreSnapshot({ siteId, start, end }) {
  if (!siteId) return null;
  const sql = db();
  const rangeKey = inferRangeKey(start, end);
  const rows = await sql`
    SELECT id, site_id, range_key, window_start, window_end, model_version,
           scores, source_scores, issue_distribution, evidence, created_at, updated_at
    FROM site_score_snapshots
    WHERE site_id = ${siteId}::uuid
      AND window_end >= ${start}
      AND window_start <= ${end}
      ${rangeKey ? sql`AND range_key = ${rangeKey}` : sql``}
    ORDER BY created_at DESC
    LIMIT 1
  `.catch((error) => {
    if (/site_score_snapshots/i.test(error?.message || '')) return [];
    throw error;
  });
  return rows[0] || null;
}
