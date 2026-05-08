import { db } from '../db.js';
import { boundsFromInput } from '../dashboard-range.js';

function average(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return 0;
  return Math.round(clean.reduce((sum, v) => sum + v, 0) / clean.length);
}

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function buildConfusion(input) {
  const { siteId, rangeKey } = input;
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = boundsFromInput(input);

  if (siteIds.length === 0) {
    return {
      totals: { repeatedSearches: 0, deadEnds: 0, dropOffs: 0, intentMismatches: 0 },
      signals: { repeatedSearches: [], deadEnds: [], dropOffs: [], intentMismatches: [] },
      confidence: { level: 'Unknown', score: 0 },
    };
  }

  const rows = await sql`
    SELECT DISTINCT ON (type) type, score, evidence, created_at
    FROM confusion_signals
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND window_end >= ${start}
      AND window_start <= ${end}
    ORDER BY type, created_at DESC
  `;

  const score = average(rows.map((r) => r.score));
  const byType = (type) => rows.filter((r) => r.type === type);
  const totalForType = (type) => {
    const row = rows.find((r) => r.type === type);
    const scoreTotal = coerceNumber(row?.score);
    if (scoreTotal > 0) return scoreTotal;
    const ev = row?.evidence;
    return Array.isArray(ev) ? ev.length : ev ? 1 : 0;
  };
  const evidenceItems = (type) =>
    byType(type).flatMap((r) => {
      const ev = r.evidence;
      return Array.isArray(ev) ? ev : ev ? [ev] : [];
    });

  return {
    totals: {
      repeatedSearches: totalForType('repeated_search'),
      deadEnds: totalForType('dead_end'),
      dropOffs: totalForType('drop_off'),
      intentMismatches: totalForType('intent_mismatch'),
    },
    signals: {
      repeatedSearches: evidenceItems('repeated_search').map((ev) => ({
        query: String(ev.query ?? ''),
        count: coerceNumber(ev.count) || 1,
        sessionId: String(ev.sessionId ?? ev.session_id ?? ''),
      })),
      deadEnds: evidenceItems('dead_end').map((ev) => ({
        url: String(ev.url ?? ''),
        at: String(ev.at ?? ev.timestamp ?? ''),
        sessionId: String(ev.sessionId ?? ev.session_id ?? ''),
        path: ev.path ? String(ev.path) : undefined,
        title: ev.title ? String(ev.title) : undefined,
        dwellMs: ev.dwellMs ? coerceNumber(ev.dwellMs) : undefined,
        reason: ev.reason ? String(ev.reason) : undefined,
      })),
      dropOffs: evidenceItems('drop_off').map((ev) => ({
        sessionId: String(ev.sessionId ?? ev.session_id ?? ''),
        lastEvent: String(ev.lastEvent ?? ev.last_event ?? ''),
        lastUrl: ev.lastUrl ? String(ev.lastUrl) : ev.last_url ? String(ev.last_url) : undefined,
        stage: ev.stage ? String(ev.stage) : undefined,
        intent: ev.intent ? String(ev.intent) : undefined,
      })),
      intentMismatches: evidenceItems('intent_mismatch').map((ev) => ({
        url: String(ev.url ?? ''),
        intent: String(ev.intent ?? ''),
        expected: String(ev.expected ?? ''),
      })),
    },
    rootCauses: [
      { key: 'repeated_search', label: 'Repeated searches', count: totalForType('repeated_search'), evidenceUrls: [] },
      { key: 'dead_end', label: 'Dead ends', count: totalForType('dead_end'), evidenceUrls: [] },
      { key: 'drop_off', label: 'Drop-offs', count: totalForType('drop_off'), evidenceUrls: [] },
      { key: 'intent_mismatch', label: 'Intent mismatches', count: totalForType('intent_mismatch'), evidenceUrls: [] },
    ].filter((rc) => rc.count > 0),
    recommendedFixes: deriveConfusionFixes(rows.find((r) => r.type === 'drop_off'), totalForType),
    confidence: { level: score >= 80 ? 'High' : score >= 50 ? 'Medium' : score > 0 ? 'Low' : 'Unknown', score },
  };
}

function deriveConfusionFixes(_dropOffRow, totalForType) {
  const fixes = [];
  if (totalForType('drop_off') > 0) {
    fixes.push('Reduce early drop-offs by tightening page clarity above the fold and improving internal navigation.');
  }
  if (totalForType('repeated_search') > 0) {
    fixes.push('Add direct answers and content for the queries visitors keep retrying so the search results page becomes the destination.');
  }
  if (totalForType('dead_end') > 0) {
    fixes.push('Review the URLs that dead-end most often: add follow-on CTAs, related links, or stronger internal navigation.');
  }
  if (totalForType('intent_mismatch') > 0) {
    fixes.push('Reconcile pages flagged for intent mismatches by aligning H1, lead paragraph, and CTA with the search query.');
  }
  return fixes.slice(0, 4);
}
