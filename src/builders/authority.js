import { db } from '../db.js';
import { boundsFromInput } from '../dashboard-range.js';
import { getScoreBand, getScoreSeverity } from '../lib/scoring.js';
import { loadLatestSiteScoreSnapshot } from '../lib/site-score-snapshot.js';

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

function deriveConfidenceGaps(authorityScore, persistedTrustSignals, blockerCount) {
  const gaps = [];
  if (authorityScore < 40) {
    gaps.push('Authority is well below target — first-party authority and trust evidence is sparse.');
  } else if (authorityScore < 60) {
    gaps.push('Authority signals are below target range; protect the highest-value pages first.');
  } else if (authorityScore < 75) {
    gaps.push('Authority is approaching target but lacks sustained signal density.');
  }
  if (blockerCount > 0) {
    gaps.push(`${blockerCount} active trust blocker${blockerCount === 1 ? '' : 's'} are limiting authority growth.`);
  }
  if (!persistedTrustSignals.length) {
    gaps.push('No persisted trust signal evidence is currently captured for this range.');
  }
  return gaps;
}

export async function buildAuthority(input) {
  const { siteId, rangeKey } = input;
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = boundsFromInput(input);

  if (siteIds.length === 0) return emptyAuthority(rangeKey, start, end);
  const scoreSnapshot = siteId ? await loadLatestSiteScoreSnapshot({ siteId, start, end }) : null;
  const snapshotScore = Number(scoreSnapshot?.scores?.siteAuthority || 0);

  const rows = await sql`
    SELECT authority_score, trust_signals, blockers, confidence, created_at
    FROM authority_signals
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND window_end >= ${start}
      AND window_start <= ${end}
    ORDER BY created_at DESC
    LIMIT 50
  `;

  if (rows.length === 0 && !scoreSnapshot) return emptyAuthority(rangeKey, start, end);

  const authorityScore = snapshotScore || average(rows.map((r) => r.authority_score || 0));
  const persistedTrustSignals = rows.flatMap((r) => Array.isArray(r.trust_signals) ? r.trust_signals : []);
  const trustSignals = persistedTrustSignals.length > 0
    ? persistedTrustSignals
    : [
        { label: 'Authority score', value: authorityScore },
        { label: 'Signal confidence', value: average(rows.map((r) => r.confidence || 0)) },
      ].filter((signal) => signal.value > 0);
  const blockers = Array.from(new Set(rows.flatMap((r) => Array.isArray(r.blockers) ? r.blockers : []))).filter(Boolean);
  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    authorityScore,
    band: getScoreBand(authorityScore),
    severity: getScoreSeverity(authorityScore),
    trustSignals: trustSignals.slice(0, 8),
    confidenceGaps: deriveConfidenceGaps(authorityScore, persistedTrustSignals, blockers.length),
    blockers,
    confidence: { level: confidenceLevel(rows.length), score: average(rows.map((r) => r.confidence || 0)) },
    scoreSnapshot: scoreSnapshot
      ? {
          id: scoreSnapshot.id,
          modelVersion: scoreSnapshot.model_version,
          generatedAt: scoreSnapshot.created_at ? new Date(scoreSnapshot.created_at).toISOString() : null,
          dataCompleteness: scoreSnapshot.evidence?.dataCompleteness || null,
        }
      : null,
  };
}

function emptyAuthority(rangeKey, start, end) {
  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    authorityScore: 0,
    band: getScoreBand(0),
    severity: 'unknown',
    trustSignals: [],
    confidenceGaps: ['No authority signals are available for this range yet.'],
    blockers: [],
    confidence: { level: 'Unknown', score: 0 },
  };
}
