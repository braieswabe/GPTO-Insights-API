import { db } from '../db.js';
import { rangeToDays } from '../types.js';

function dateWindow(rangeKey) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - rangeToDays(rangeKey));
  return { start, end };
}

function average(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return 0;
  return Math.round(clean.reduce((sum, v) => sum + v, 0) / clean.length);
}

function confidenceLevel(count) {
  if (count > 20) return 'High';
  if (count > 5) return 'Medium';
  if (count > 0) return 'Low';
  return 'Unknown';
}

export async function buildAuthority({ siteId, rangeKey }) {
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = dateWindow(rangeKey);

  if (siteIds.length === 0) return emptyAuthority();

  const rows = await sql`
    SELECT authority_score, trust_signals, blockers, confidence, created_at
    FROM authority_signals
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND window_end >= ${start}
      AND window_start <= ${end}
    ORDER BY created_at DESC
    LIMIT 50
  `;

  if (rows.length === 0) return emptyAuthority();

  const authorityScore = average(rows.map((r) => r.authority_score || 0));
  const persistedTrustSignals = rows.flatMap((r) => Array.isArray(r.trust_signals) ? r.trust_signals : []);
  const trustSignals = persistedTrustSignals.length > 0
    ? persistedTrustSignals
    : [
        { label: 'Authority score', value: authorityScore },
        { label: 'Signal confidence', value: average(rows.map((r) => r.confidence || 0)) },
      ].filter((signal) => signal.value > 0);
  const blockers = Array.from(new Set(rows.flatMap((r) => Array.isArray(r.blockers) ? r.blockers : []))).slice(0, 1);
  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    authorityScore,
    trustSignals: trustSignals.slice(0, 8),
    confidenceGaps: authorityScore < 60 ? ['Authority signals are below target range.'] : [],
    blockers,
    confidence: { level: confidenceLevel(rows.length), score: average(rows.map((r) => r.confidence || 0)) },
  };
}

function emptyAuthority() {
  return {
    authorityScore: 0,
    trustSignals: [],
    confidenceGaps: [],
    blockers: [],
    confidence: { level: 'Unknown', score: 0 },
  };
}
