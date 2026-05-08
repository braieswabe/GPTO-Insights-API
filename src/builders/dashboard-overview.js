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
  };
}
