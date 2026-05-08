import { db } from '../db.js';
import { boundsFromInput } from '../dashboard-range.js';
import { averageEngagementScore, deriveExperienceBand, getScoreBand, getScoreSeverity } from '../lib/scoring.js';

export async function buildExperience(input) {
  const { siteId, rangeKey } = input;
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = boundsFromInput(input);

  if (siteIds.length === 0) {
    return {
      range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
      pages: [],
      anomalies: [],
      healthScore: null,
      band: 'Idle',
      severity: 'unknown',
      insufficientData: { message: 'No sites available.' },
    };
  }

  let [pages, anomalies] = await Promise.all([
    sql`
      SELECT url, engagement, technical, page_quality, score, confidence, created_at
      FROM experience_signals
      WHERE site_id = ANY(${siteIds}::uuid[])
        AND window_end >= ${start}
        AND window_start <= ${end}
      ORDER BY created_at DESC
      LIMIT 100
    `,
    sql`
      SELECT category, severity, message, evidence, created_at
      FROM telemetry_anomalies
      WHERE site_id = ANY(${siteIds}::uuid[])
        AND window_end >= ${start}
        AND window_start <= ${end}
      ORDER BY created_at DESC
      LIMIT 20
    `,
  ]);

  if (pages.length === 0) {
    pages = await sql`
      SELECT url, engagement, technical, page_quality, score, confidence, created_at
      FROM experience_signals
      WHERE site_id = ANY(${siteIds}::uuid[])
      ORDER BY created_at DESC
      LIMIT 100
    `;
  }

  const mapped = pages.map((r) => ({
    url: r.url,
    engagement: r.engagement,
    technical: r.technical,
    pageQuality: r.page_quality,
    score: r.score,
    confidence: r.confidence,
  }));
  const healthScore = averageEngagementScore({ pages: mapped });
  const band = healthScore !== null ? getScoreBand(healthScore) : deriveExperienceBand(mapped.length);
  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    pages: mapped,
    anomalies,
    healthScore,
    band,
    severity: healthScore !== null ? getScoreSeverity(healthScore) : 'unknown',
    insufficientData: mapped.length === 0 ? { message: 'No cached experience diagnostics are available yet.' } : null,
  };
}
