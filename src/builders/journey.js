import { db } from '../db.js';
import { rangeToDays } from '../types.js';

function dateWindow(rangeKey) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - rangeToDays(rangeKey));
  return { start, end };
}

export async function buildJourney({ siteId, rangeKey }) {
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = dateWindow(rangeKey);

  if (siteIds.length === 0) {
    return { range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey }, rows: [], insufficientData: { message: 'No sites available.' } };
  }

  const rows = await sql`
    SELECT entry_url, exit_url, path, step_count, loops, backtracks, stalls, confidence
    FROM journey_signals
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND window_end >= ${start}
      AND window_start <= ${end}
    ORDER BY created_at DESC
    LIMIT 100
  `;

  const seen = new Set();
  const deduplicated = rows.filter((r) => {
    const key = `${(r.entry_url || '').replace(/\/$/, '')}|${(r.exit_url || '').replace(/\/$/, '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    rows: deduplicated.map((r) => ({
      entryUrl: r.entry_url,
      exitUrl: r.exit_url,
      path: r.path,
      stepCount: r.step_count,
      loops: r.loops,
      backtracks: r.backtracks,
      stalls: r.stalls,
      confidence: r.confidence,
    })),
    insufficientData: deduplicated.length === 0 ? { message: 'No journey signals available for this range yet.' } : null,
  };
}
