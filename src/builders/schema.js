import { db } from '../db.js';
import { rangeToDays } from '../types.js';

function dateWindow(rangeKey) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - rangeToDays(rangeKey));
  return { start, end };
}

function average(values) {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100;
}

function parseMetricValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function buildSchema({ siteId, rangeKey }) {
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = dateWindow(rangeKey);

  if (siteIds.length === 0) {
    return {
      range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
      completenessScore: 0,
      qualityScore: 0,
      missing: 0,
      broken: 0,
      templates: [],
    };
  }

  const events = await sql`
    SELECT metrics
    FROM telemetry_events
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND timestamp >= ${start}
      AND timestamp <= ${end}
    LIMIT 500
  `;

  const completenessValues = [];
  const qualityValues = [];
  let missing = 0;
  let broken = 0;

  for (const event of events) {
    const metrics = event.metrics;
    if (!metrics || typeof metrics !== 'object') continue;
    const completeness = parseMetricValue(metrics['ai.schemaCompleteness']);
    const quality = parseMetricValue(metrics['ai.structuredDataQuality']);
    if (completeness !== null) {
      completenessValues.push(completeness);
      if (completeness < 0.6) missing++;
    }
    if (quality !== null) {
      qualityValues.push(quality);
      if (quality < 0.6) broken++;
    }
  }

  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    completenessScore: Math.round(average(completenessValues) * 100),
    qualityScore: Math.round(average(qualityValues) * 100),
    missing,
    broken,
    templates: [
      { name: 'Organization', status: 'available' },
      { name: 'Product', status: 'available' },
      { name: 'FAQ', status: 'available' },
      { name: 'Service', status: 'available' },
    ],
    insufficientData: events.length === 0 ? { message: 'No schema telemetry available for this range yet.' } : null,
  };
}
