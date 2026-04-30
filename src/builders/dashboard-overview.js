import { db } from '../db.js';
import { rangeToDays } from '../types.js';
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

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

export async function buildDashboardOverview(input) {
  const sql = db();
  const sites = input.siteId
    ? await sql`SELECT id, domain, status, created_at, updated_at FROM sites WHERE id = ${input.siteId}::uuid`
    : await sql`SELECT id, domain, status, created_at, updated_at FROM sites ORDER BY domain ASC`;

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
    llmMentions = await buildLlmMentionsOverview({
      siteId: input.siteId,
      days: rangeToDays(input.rangeKey),
      sources: ['chat_gpt', 'google_ai_overviews'],
    }).catch(() => null);
  }

  return {
    sites: sites.length,
    sitesList: sites.map((s) => ({
      id: s.id,
      domain: s.domain,
      status: s.status,
      createdAt: iso(s.created_at),
      updatedAt: iso(s.updated_at),
    })),
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
