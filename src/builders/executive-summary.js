import { buildTelemetry } from './telemetry.js';
import { buildAuthority } from './authority.js';
import { buildExperience } from './experience.js';
import { buildSearchDiagnostics } from './search-diagnostics.js';

export async function buildExecutiveSummary(input) {
  const [telemetry, authority, experience, searchDiagnostics] = await Promise.all([
    buildTelemetry(input),
    buildAuthority(input),
    buildExperience(input),
    buildSearchDiagnostics(input),
  ]);

  const insights = [
    {
      question: 'Is the site gaining usable AI-search momentum?',
      answer:
        telemetry.totals.pageViews > 0
          ? `${telemetry.totals.pageViews.toLocaleString()} page views and ${telemetry.totals.searches.toLocaleString()} searches are represented in cached rollups for this range.`
          : 'No cached telemetry rollups are available for this range yet.',
    },
    {
      question: 'Are trust signals strong enough?',
      answer:
        authority.authorityScore > 0
          ? `Authority is currently ${authority.authorityScore}/100 with ${authority.trustSignals.length} trust signals represented.`
          : 'Authority signals are still building.',
    },
    {
      question: 'What needs attention first?',
      answer:
        searchDiagnostics.rows.length > 0
          ? 'Search diagnostics show user-query friction that should be reviewed before deeper content changes.'
          : experience.pages.length > 0
            ? 'Experience diagnostics are available; prioritize low-scoring pages first.'
            : 'No cached search or experience diagnostics are available yet.',
    },
  ];

  return {
    range: telemetry.range,
    insights,
    aiVisibility: null,
  };
}
