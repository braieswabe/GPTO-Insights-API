import { db } from '../db.js';
import { loadSitesWithConnectionFields } from '../site-connection.js';
import { boundsDaySpan, boundsFromInput } from '../dashboard-range.js';
import { buildTelemetry } from './telemetry.js';
import { buildAuthority } from './authority.js';
import { buildConfusion } from './confusion.js';
import { buildCoverage } from './coverage.js';
import { buildSchema } from './schema.js';
import { buildJourney } from './journey.js';
import { buildIndex } from './index-module.js';
import { buildExperience } from './experience.js';
import { buildSearchDiagnostics } from './search-diagnostics.js';
import { buildExecutiveSummary } from './executive-summary.js';
import { buildAiReadability } from './ai-readability.js';
import { buildLlmMentionsOverview } from './llm-mentions.js';

export { buildIndex, buildAiReadability };

export async function buildDashboardOverview(input) {
  const sql = db();
  const sitesList = await loadSitesWithConnectionFields(sql, input.siteId);

  const [telemetry, authority, executiveSummary, experience, searchDiagnostics, confusion, coverage, schema, journey, indexData, aiReadability] =
    await Promise.all([
      buildTelemetry(input),
      buildAuthority(input),
      buildExecutiveSummary(input),
      buildExperience(input),
      buildSearchDiagnostics(input),
      buildConfusion(input),
      buildCoverage(input),
      buildSchema(input),
      buildJourney(input),
      buildIndex(input),
      buildAiReadability(input).catch(() => null),
    ]);

  let llmMentions = null;
  if (input.siteId) {
    const { start, end } = boundsFromInput(input);
    const spanDays = boundsDaySpan({ start, end });
    llmMentions = await buildLlmMentionsOverview({
      siteId: input.siteId,
      days: spanDays,
      windowStart: start,
      windowEnd: end,
      sources: ['chat_gpt', 'google_ai_overviews'],
    }).catch(() => null);
  }

  const display = buildDisplayLayer({
    telemetry,
    authority,
    schema,
    coverage,
    confusion,
    experience,
    journey,
    llmMentions,
    executiveSummary,
  });

  return {
    sites: sitesList.length,
    sitesList,
    telemetry,
    authority,
    executiveSummary,
    experience,
    searchDiagnostics,
    confusion,
    coverage,
    schema,
    journey,
    llmMentions,
    dashboardIndex: indexData?.dashboards ?? [],
    llmAiVisibilityIndex: indexData?.llmAiVisibility ?? null,
    aiReadability,
    display,
  };
}

function buildDisplayLayer({ telemetry, authority, schema, coverage, confusion, experience, journey, llmMentions, executiveSummary }) {
  const llmComposite = llmMentions?.aiVisibility?.composite ?? executiveSummary?.aiVisibility?.composite ?? null;
  return {
    authority: {
      score: authority?.authorityScore ?? null,
      band: authority?.band ?? null,
      severity: authority?.severity ?? null,
    },
    schema: {
      completenessScore: schema?.completenessScore ?? null,
      qualityScore: schema?.qualityScore ?? null,
      band: schema?.band ?? null,
      severity: schema?.severity ?? null,
    },
    coverage: {
      priorityFixes: coverage?.totals?.priorityFixes ?? 0,
      riskBand: coverage?.riskBand ?? null,
      riskLabel: executiveSummary?.pulseBlends?.coverageRisk?.label ?? null,
    },
    confusion: {
      total: confusion?.totals
        ? Number(confusion.totals.repeatedSearches || 0)
          + Number(confusion.totals.deadEnds || 0)
          + Number(confusion.totals.dropOffs || 0)
          + Number(confusion.totals.intentMismatches || 0)
        : 0,
      confidence: confusion?.confidence?.level ?? 'Unknown',
    },
    experience: {
      healthScore: experience?.healthScore ?? executiveSummary?.pulseBlends?.experienceHealth?.score ?? null,
      band: experience?.band ?? null,
      severity: experience?.severity ?? null,
    },
    journey: {
      rowCount: journey?.rowCount ?? (journey?.rows?.length ?? 0),
      loops: journey?.loops ?? 0,
      strengthBand: journey?.strengthBand ?? null,
    },
    aiVisibility: {
      composite: llmComposite,
      band: llmMentions?.aiVisibility?.band ?? executiveSummary?.aiVisibility?.band ?? null,
      severity: executiveSummary?.aiVisibility?.severity ?? null,
      mentions: llmMentions?.summary?.metrics?.mentions ?? null,
      aiSearchVolume: llmMentions?.summary?.metrics?.aiSearchVolume ?? null,
      impressions: llmMentions?.summary?.metrics?.impressions ?? null,
    },
    telemetry: {
      pageViews: telemetry?.totals?.pageViews ?? 0,
      visits: telemetry?.totals?.visits ?? 0,
      trendPctLabel: telemetry?.trendPctLabel || null,
      trendPct: telemetry?.trendPct || null,
    },
    signalChips: executiveSummary?.signalChips || [],
    pulseBlends: executiveSummary?.pulseBlends || null,
  };
}
