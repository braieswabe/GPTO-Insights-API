import { db } from '../db.js';
import { boundsFromInput } from '../dashboard-range.js';
import { getScoreBand, getScoreSeverity } from '../lib/scoring.js';

const TEMPLATE_KEYS = [
  { key: 'organization', label: 'Organization' },
  { key: 'product', label: 'Product' },
  { key: 'faq', label: 'FAQ' },
  { key: 'service', label: 'Service' },
  { key: 'article', label: 'Article' },
  { key: 'review', label: 'Review' },
  { key: 'breadcrumb', label: 'Breadcrumb' },
  { key: 'how_to', label: 'How-to' },
  { key: 'local_business', label: 'Local Business' },
  { key: 'event', label: 'Event' },
];

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

function pickTemplateBag(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const bag =
    metrics['ai.schemaTemplates'] ||
    metrics.schemaTemplates ||
    metrics['structuredData.templates'] ||
    metrics['ai.structuredDataTemplates'] ||
    null;
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return null;
  return bag;
}

function templateStatusFromMetric(value) {
  if (value === true) return 'available';
  if (value === false) return 'missing';
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'available' || v === 'present' || v === 'ok') return 'available';
    if (v === 'broken' || v === 'invalid') return 'broken';
    if (v === 'missing' || v === 'absent') return 'missing';
    return v;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 0.8) return 'available';
    if (value >= 0.4) return 'partial';
    return 'broken';
  }
  return 'unknown';
}

function deriveTemplates(events) {
  const summary = new Map();
  for (const event of events) {
    const bag = pickTemplateBag(event.metrics);
    if (!bag) continue;
    for (const [rawKey, raw] of Object.entries(bag)) {
      const key = String(rawKey).toLowerCase();
      const status = templateStatusFromMetric(raw);
      const entry = summary.get(key) || { available: 0, missing: 0, broken: 0, partial: 0, unknown: 0, total: 0 };
      entry.total += 1;
      if (status === 'available') entry.available += 1;
      else if (status === 'missing') entry.missing += 1;
      else if (status === 'broken') entry.broken += 1;
      else if (status === 'partial') entry.partial += 1;
      else entry.unknown += 1;
      summary.set(key, entry);
    }
  }

  if (summary.size === 0) {
    return TEMPLATE_KEYS.map((t) => ({ name: t.label, key: t.key, status: 'unknown', sampleSize: 0 }));
  }

  const out = [];
  const seen = new Set();
  for (const tpl of TEMPLATE_KEYS) {
    const stats = summary.get(tpl.key);
    seen.add(tpl.key);
    if (!stats) {
      out.push({ name: tpl.label, key: tpl.key, status: 'missing', sampleSize: 0 });
      continue;
    }
    out.push(formatTemplateStats(tpl.label, tpl.key, stats));
  }
  for (const [key, stats] of summary.entries()) {
    if (seen.has(key)) continue;
    out.push(formatTemplateStats(toTitleCase(key), key, stats));
  }
  return out;
}

function formatTemplateStats(label, key, stats) {
  const dominant = ['available', 'partial', 'broken', 'missing', 'unknown']
    .filter((s) => stats[s] > 0)
    .sort((a, b) => stats[b] - stats[a])[0] || 'unknown';
  return {
    name: label,
    key,
    status: dominant,
    sampleSize: stats.total,
    counts: {
      available: stats.available,
      partial: stats.partial,
      broken: stats.broken,
      missing: stats.missing,
      unknown: stats.unknown,
    },
  };
}

function toTitleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function buildSchema(input) {
  const { siteId, rangeKey } = input;
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = boundsFromInput(input);

  if (siteIds.length === 0) {
    return {
      range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
      completenessScore: 0,
      qualityScore: 0,
      band: getScoreBand(0),
      severity: 'unknown',
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

  const completenessScore = Math.round(average(completenessValues) * 100);
  const qualityScore = Math.round(average(qualityValues) * 100);

  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    completenessScore,
    qualityScore,
    band: getScoreBand(completenessScore),
    severity: getScoreSeverity(completenessScore),
    missing,
    broken,
    templates: deriveTemplates(events),
    insufficientData: events.length === 0 ? { message: 'No schema telemetry available for this range yet.' } : null,
  };
}
