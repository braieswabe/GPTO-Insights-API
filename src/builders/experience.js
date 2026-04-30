import { db } from '../db.js';
import { rangeToDays } from '../types.js';

function dateWindow(rangeKey) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - rangeToDays(rangeKey));
  return { start, end };
}

export async function buildExperience({ siteId, rangeKey }) {
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = dateWindow(rangeKey);

  if (siteIds.length === 0) {
    return { range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey }, pages: [], anomalies: [], insufficientData: { message: 'No sites available.' } };
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

  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    pages: pages.map((r) => ({
      url: r.url,
      engagement: r.engagement,
      technical: r.technical,
      pageQuality: r.page_quality,
      score: r.score,
      confidence: r.confidence,
    })),
    anomalies,
    insufficientData: pages.length === 0 ? { message: 'No cached experience diagnostics are available yet.' } : null,
  };
}
