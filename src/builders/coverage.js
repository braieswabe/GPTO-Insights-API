import { db } from '../db.js';
import { boundsFromInput } from '../dashboard-range.js';

function average(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return 0;
  return Math.round(clean.reduce((sum, v) => sum + v, 0) / clean.length);
}

export async function buildCoverage(input) {
  const { siteId, rangeKey } = input;
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = boundsFromInput(input);

  if (siteIds.length === 0) {
    return {
      totals: { contentGaps: 0, missingFunnelStages: 0, missingIntents: 0, priorityFixes: 0 },
      gaps: [],
      missingStages: [],
      missingIntents: [],
      confidence: { level: 'Unknown', score: 0 },
    };
  }

  const rows = await sql`
    SELECT missing_intents, missing_stages, gaps, confidence, created_at
    FROM coverage_signals
    WHERE site_id = ANY(${siteIds}::uuid[])
      AND window_end >= ${start}
      AND window_start <= ${end}
    ORDER BY created_at DESC
    LIMIT 50
  `;

  if (rows.length === 0) return null;

  const confidenceScore = average(rows.map((r) => r.confidence));
  const allGaps = rows.flatMap((r) => (Array.isArray(r.gaps) ? r.gaps : []));
  const allMissingIntents = rows.flatMap((r) => (Array.isArray(r.missing_intents) ? r.missing_intents : []));
  const allMissingStages = rows.flatMap((r) => (Array.isArray(r.missing_stages) ? r.missing_stages : []));
  const uniqueIntents = [...new Set(allMissingIntents)];
  const uniqueStages = [...new Set(allMissingStages)];
  const priorityItems = allGaps.filter((g) => g.severity === 'high' || g.severity === 'critical');

  return {
    totals: {
      contentGaps: allGaps.length,
      missingFunnelStages: uniqueStages.length,
      missingIntents: uniqueIntents.length,
      priorityFixes: priorityItems.length,
    },
    gaps: allGaps.map((g) => ({
      label: String(g.label ?? g.name ?? 'Gap'),
      detail: String(g.detail ?? g.description ?? ''),
      severity: String(g.severity ?? 'medium'),
    })),
    missingStages: uniqueStages,
    missingIntents: uniqueIntents,
    priorityItems: priorityItems.map((g) => ({
      label: String(g.label ?? g.name ?? 'Fix'),
      severity: String(g.severity ?? 'high'),
      detail: String(g.detail ?? g.description ?? ''),
      pages: Array.isArray(g.pages) ? g.pages.map(String) : undefined,
    })),
    stageBreakdown: uniqueStages.map((stage) => {
      const relatedGaps = allGaps.filter((g) => g.stage === stage || g.funnel_stage === stage);
      return {
        stage,
        stageLabel: stage.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        missing: true,
        evidenceCount: relatedGaps.length || 1,
        pages: relatedGaps.flatMap((g) => Array.isArray(g.pages) ? g.pages.map(String) : []).slice(0, 3),
      };
    }),
    recommendedFixes: priorityItems.slice(0, 3).map((g) => String(g.recommendation ?? g.label ?? 'Review content coverage')),
    confidence: {
      level: confidenceScore >= 80 ? 'High' : confidenceScore >= 50 ? 'Medium' : confidenceScore > 0 ? 'Low' : 'Unknown',
      score: confidenceScore,
    },
  };
}
