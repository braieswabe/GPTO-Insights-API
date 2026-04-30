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
import { buildDashboardOverview } from './dashboard-overview.js';
import { rangeToDays } from '../types.js';

export { buildDashboardOverview } from './dashboard-overview.js';
export { buildLlmMentionsOverview, buildLlmMentionsTrends, buildLlmMentionsCompetitors, buildLlmMentionsPromptIntelligence, buildLlmMentionsSourceGap } from './llm-mentions.js';

export async function buildModule(moduleKey, input) {
  if (moduleKey === 'overview') return buildDashboardOverview(input);
  if (moduleKey === 'telemetry') return buildTelemetry(input);
  if (moduleKey === 'authority') return buildAuthority(input);
  if (moduleKey === 'confusion') return buildConfusion(input);
  if (moduleKey === 'coverage') return buildCoverage(input);
  if (moduleKey === 'schema') return buildSchema(input);
  if (moduleKey === 'journey') return buildJourney(input);
  if (moduleKey === 'index') return buildIndex(input);
  if (moduleKey === 'experience') return buildExperience(input);
  if (moduleKey === 'search_diagnostics') return buildSearchDiagnostics(input);
  if (moduleKey === 'executive_summary') return buildExecutiveSummary(input);
  if (moduleKey === 'ai_readability') return buildAiReadability(input);
  if (moduleKey === 'llm_mentions_overview') {
    return buildLlmMentionsOverview({
      siteId: input.siteId,
      days: rangeToDays(input.rangeKey),
      sources: ['chat_gpt', 'google_ai_overviews'],
    });
  }
  const error = new Error(`Unsupported module: ${moduleKey}`);
  error.statusCode = 404;
  throw error;
}
