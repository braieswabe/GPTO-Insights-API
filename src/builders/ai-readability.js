import { db } from '../db.js';
import { boundsFromInput } from '../dashboard-range.js';

export async function buildAiReadability(input) {
  const { siteId, rangeKey } = input;
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = boundsFromInput(input);

  if (siteIds.length === 0) return null;

  let rows = await sql`
    SELECT overall, categories, sub_metrics, grades, actions, evidence, confidence, created_at
    FROM readability_signals
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND window_end >= ${start}
      AND window_start <= ${end}
    ORDER BY created_at DESC
    LIMIT 5
  `;

  if (rows.length === 0) {
    rows = await sql`
      SELECT overall, categories, sub_metrics, grades, actions, evidence, confidence, created_at
      FROM readability_signals
      WHERE site_id = ANY(${siteIds}::uuid[])
      ORDER BY created_at DESC
      LIMIT 1
    `;
  }

  if (rows.length === 0) return null;

  const latest = rows[0];
  return {
    frameworkVersion: 'gpto-ai-readability-v1',
    updatedAt: latest.created_at ? new Date(latest.created_at).toISOString() : new Date().toISOString(),
    statement: 'A GPTO audit measures how clearly and confidently your website communicates with search engines and AI, not how much traffic it currently gets.',
    doesNotMeasure: [],
    packageTier: 'gold',
    overall: latest.overall,
    categories: latest.categories,
    subMetrics: latest.sub_metrics,
    grades: latest.grades,
    actions: latest.actions,
    recommendedActions: Array.isArray(latest.actions) ? latest.actions : [],
    evidence: latest.evidence,
    confidence: latest.confidence,
    generatedAt: latest.created_at ? new Date(latest.created_at).toISOString() : null,
  };
}
