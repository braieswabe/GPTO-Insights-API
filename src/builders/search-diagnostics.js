import { db } from '../db.js';
import { rangeToDays } from '../types.js';

function dateWindow(rangeKey) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - rangeToDays(rangeKey));
  return { start, end };
}

export async function buildSearchDiagnostics({ siteId, rangeKey }) {
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = dateWindow(rangeKey);

  if (siteIds.length === 0) {
    return { range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey }, rows: [], insufficientData: { message: 'No sites available.' } };
  }

  const rows = await sql`
    SELECT query_hash, query_class, reformulations, zero_result_hints, affected_pages, confidence, created_at
    FROM search_signals
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND window_end >= ${start}
      AND window_start <= ${end}
    ORDER BY created_at DESC
    LIMIT 50
  `;

  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    rows: rows.map((r) => ({
      queryHash: r.query_hash,
      queryClass: r.query_class,
      reformulations: r.reformulations,
      zeroResultHints: r.zero_result_hints,
      affectedPages: r.affected_pages,
      confidence: r.confidence,
    })),
    insufficientData: rows.length === 0 ? { message: 'No cached search diagnostics are available yet.' } : null,
  };
}
