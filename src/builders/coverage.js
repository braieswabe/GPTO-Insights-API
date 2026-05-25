import { db } from '../db.js';
import { boundsFromInput } from '../dashboard-range.js';
import { loadLatestSiteScoreSnapshot } from '../lib/site-score-snapshot.js';

function average(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return 0;
  return Math.round(clean.reduce((sum, v) => sum + v, 0) / clean.length);
}

function emptyCoverage(rangeKey, start, end, message) {
  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    totals: { contentGaps: 0, missingFunnelStages: 0, missingIntents: 0, priorityFixes: 0 },
    gaps: [],
    missingStages: [],
    missingIntents: [],
    priorityItems: [],
    stageBreakdown: [],
    recommendedFixes: [],
    confidence: { level: 'Unknown', score: 0 },
    riskBand: 'unknown',
    insufficientData: { message },
  };
}

export async function buildCoverage(input) {
  const { siteId, rangeKey } = input;
  const sql = db();
  const siteIds = siteId ? [siteId] : (await sql`SELECT id FROM sites`).map((r) => r.id);
  const { start, end } = boundsFromInput(input);

  if (siteIds.length === 0) {
    return emptyCoverage(rangeKey, start, end, 'No sites available.');
  }
  const scoreSnapshot = siteId ? await loadLatestSiteScoreSnapshot({ siteId, start, end }) : null;
  if (scoreSnapshot) {
    const issues = Array.isArray(scoreSnapshot.issue_distribution) ? scoreSnapshot.issue_distribution : [];
    const priorityItems = issues.filter((issue) => ['high', 'critical'].includes(String(issue.severity || '').toLowerCase()));
    const totals = {
      contentGaps: Number(scoreSnapshot.scores?.contentIssues || 0),
      missingFunnelStages: 0,
      missingIntents: 0,
      priorityFixes: priorityItems.length,
    };
    return {
      range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
      totals,
      contentCoverageBand: scoreSnapshot.scores?.contentCoverageBand || 'Unknown',
      gaps: issues.map((issue) => ({
        label: String(issue.label || 'Content issue'),
        detail: `${Number(issue.count || 1)} page${Number(issue.count || 1) === 1 ? '' : 's'}`,
        severity: String(issue.severity || 'medium'),
      })),
      missingStages: [],
      missingIntents: [],
      priorityItems: priorityItems.map((issue) => ({
        label: String(issue.label || 'Content issue'),
        severity: String(issue.severity || 'high'),
        detail: `${Number(issue.count || 1)} page${Number(issue.count || 1) === 1 ? '' : 's'}`,
        pages: Array.isArray(issue.pages) ? issue.pages.map(String) : [],
      })),
      stageBreakdown: [],
      recommendedFixes: priorityItems.slice(0, 3).map((issue) => `Address ${String(issue.label || 'content issue')}.`),
      confidence: {
        level: 'Medium',
        score: Number(scoreSnapshot.evidence?.scoringInputs?.coverageConfidence || 0),
      },
      riskBand: deriveCoverageRiskBand(totals),
      scoreSnapshot: {
        id: scoreSnapshot.id,
        modelVersion: scoreSnapshot.model_version,
        generatedAt: scoreSnapshot.created_at ? new Date(scoreSnapshot.created_at).toISOString() : null,
        dataCompleteness: scoreSnapshot.evidence?.dataCompleteness || null,
      },
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

  if (rows.length === 0) {
    return emptyCoverage(rangeKey, start, end, 'No coverage signals available for this range yet.');
  }

  const confidenceScore = average(rows.map((r) => r.confidence));
  const allGaps = rows.flatMap((r) => (Array.isArray(r.gaps) ? r.gaps : []));
  const allMissingIntents = rows.flatMap((r) => (Array.isArray(r.missing_intents) ? r.missing_intents : []));
  const allMissingStages = rows.flatMap((r) => (Array.isArray(r.missing_stages) ? r.missing_stages : []));
  const uniqueIntents = [...new Set(allMissingIntents)];
  const uniqueStages = [...new Set(allMissingStages)];
  const priorityItems = allGaps.filter((g) => g.severity === 'high' || g.severity === 'critical');

  const totals = {
    contentGaps: allGaps.length,
    missingFunnelStages: uniqueStages.length,
    missingIntents: uniqueIntents.length,
    priorityFixes: priorityItems.length,
  };

  return {
    range: { start: start.toISOString(), end: end.toISOString(), range: rangeKey },
    totals,
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
    riskBand: deriveCoverageRiskBand(totals),
  };
}

export function deriveCoverageRiskBand(totals) {
  if (!totals) return 'unknown';
  const priority = Number(totals.priorityFixes || 0);
  const missingStages = Number(totals.missingFunnelStages || 0);
  const contentGaps = Number(totals.contentGaps || 0);
  if (priority >= 5 || missingStages >= 3) return 'high';
  if (priority >= 2 || missingStages >= 1 || contentGaps >= 5) return 'medium';
  if (contentGaps > 0 || priority > 0) return 'low';
  return 'minimal';
}
