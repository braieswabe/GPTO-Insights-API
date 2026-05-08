import { db } from '../db.js';
import { boundsFromInput } from '../dashboard-range.js';
import { deriveJourneyStrengthBand } from '../lib/scoring.js';

export async function buildJourney(input) {
  const { siteId, rangeKey } = input;
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = boundsFromInput(input);

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

  const rowsOut = deduplicated.map((r) => ({
    entryUrl: r.entry_url,
    exitUrl: r.exit_url,
    path: r.path,
    stepCount: r.step_count,
    loops: r.loops,
    backtracks: r.backtracks,
    stalls: r.stalls,
    confidence: r.confidence,
  }));
  const loops = rowsOut.filter((r) => Number(r.loops || 0) > 0).length;
  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    rows: rowsOut,
    rowCount: rowsOut.length,
    loops,
    strengthBand: deriveJourneyStrengthBand(rowsOut.length),
    insufficientData: rowsOut.length === 0 ? { message: 'No journey signals available for this range yet.' } : null,
  };
}
