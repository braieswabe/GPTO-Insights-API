import { buildTelemetry } from './telemetry.js';
import { buildAuthority } from './authority.js';
import { buildExperience } from './experience.js';
import { buildSearchDiagnostics } from './search-diagnostics.js';
import { buildConfusion } from './confusion.js';
import { buildCoverage } from './coverage.js';
import { buildSchema } from './schema.js';
import { buildJourney } from './journey.js';
import {
  buildExperienceHealth,
  confidenceToStatus,
  coverageRiskLabel,
  deriveCoverageRiskBand,
  deriveExperienceBand,
  deriveJourneyStrengthBand,
  formatTrendPercent,
  getScoreBand,
  getScoreSeverity,
} from '../lib/scoring.js';

export async function buildExecutiveSummary(input) {
  const [telemetry, authority, experience, searchDiagnostics, confusion, coverage, schema, journey] = await Promise.all([
    buildTelemetry(input),
    buildAuthority(input),
    buildExperience(input),
    buildSearchDiagnostics(input),
    buildConfusion(input),
    buildCoverage(input),
    buildSchema(input),
    buildJourney(input),
  ]);

  const llmSignals = telemetry?.llmMentionsSignals || null;
  const aiComposite = llmSignals?.composite ?? null;
  const aiVisibilityBlock = aiComposite != null
    ? {
        composite: aiComposite,
        band: llmSignals?.band || getScoreBand(aiComposite),
        severity: getScoreSeverity(aiComposite),
        mentions: llmSignals?.mentions ?? null,
        aiSearchVolume: llmSignals?.aiSearchVolume ?? null,
        impressions: llmSignals?.impressions ?? null,
        lastUpdatedAt: llmSignals?.lastUpdatedAt || null,
        freshness: llmSignals?.freshness || null,
        narrative: llmSignals?.freshness?.summary || null,
      }
    : null;

  const experienceBlend = buildExperienceHealth(confusion, experience, telemetry);
  const coverageRisk = coverageRiskLabel(coverage?.totals);
  const journeyBand = deriveJourneyStrengthBand((journey?.rows || []).length);
  const experienceBand = deriveExperienceBand((experience?.pages || []).length);

  const signalChips = buildSignalChipsForSummary({
    telemetry,
    confusion,
    authority,
    schema,
    coverage,
    journey,
    experience,
    aiVisibility: aiVisibilityBlock,
  });

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
    aiVisibility: aiVisibilityBlock,
    signalChips,
    pulseBlends: {
      experienceHealth: experienceBlend,
      coverageRisk: {
        label: coverageRisk,
        band: deriveCoverageRiskBand(coverage?.totals),
      },
      journeyStrength: { rows: (journey?.rows || []).length, band: journeyBand },
      experience: { pages: (experience?.pages || []).length, band: experienceBand },
      pageViewsTrendLabel: formatTrendPercent(telemetry?.trend?.pageViews),
      visitsTrendLabel: formatTrendPercent(telemetry?.trend?.visits),
    },
  };
}

function chipDetail(parts) {
  return parts.filter(Boolean).join(', ') || 'No data yet';
}

function buildSignalChipsForSummary({ telemetry, confusion, authority, schema, coverage, journey, experience, aiVisibility }) {
  const confusionTotal = confusion?.totals
    ? confusion.totals.repeatedSearches + confusion.totals.deadEnds + confusion.totals.dropOffs + confusion.totals.intentMismatches
    : 0;
  const journeyRows = (journey?.rows || []).length;
  const journeyLoops = (journey?.rows || []).filter((r) => Number(r.loops || 0) > 0).length;
  const experiencePages = (experience?.pages || []).length;
  const avgEngagement = (() => {
    const scored = (experience?.pages || []).filter((p) => typeof p.score === 'number' && p.score > 0);
    if (!scored.length) return null;
    return Math.round(scored.reduce((sum, p) => sum + p.score, 0) / scored.length);
  })();

  return [
    {
      key: 'telemetry',
      label: 'Telemetry',
      status: telemetry?.totals?.pageViews > 0 ? 'Strong' : 'Idle',
      detail: telemetry
        ? `${telemetry.totals.pageViews.toLocaleString()} views (${formatTrendPercent(telemetry.trend.pageViews) || '0%'})`
        : 'No data yet',
    },
    {
      key: 'confusion',
      label: 'Confusion',
      status: confidenceToStatus(confusion?.confidence?.level),
      detail: confusion
        ? `${confusionTotal} friction signal${confusionTotal !== 1 ? 's' : ''}`
        : 'No data yet',
    },
    {
      key: 'authority',
      label: 'Authority',
      status: confidenceToStatus(authority?.confidence?.level),
      detail: authority ? `Score ${authority.authorityScore}/100` : 'No data yet',
    },
    {
      key: 'schema',
      label: 'Schema',
      status: typeof schema?.completenessScore === 'number' ? confidenceToStatus(schema?.completenessScore >= 75 ? 'High' : schema?.completenessScore >= 50 ? 'Medium' : schema?.completenessScore > 0 ? 'Low' : 'Unknown') : 'Idle',
      detail: schema ? `Completeness ${schema.completenessScore}/100` : 'No data yet',
    },
    {
      key: 'coverage',
      label: 'Coverage',
      status: confidenceToStatus(coverage?.confidence?.level),
      detail: coverage?.totals
        ? chipDetail([
            `${coverage.totals.contentGaps} gap${coverage.totals.contentGaps !== 1 ? 's' : ''}`,
            coverage.totals.missingFunnelStages > 0 ? `${coverage.totals.missingFunnelStages} stage${coverage.totals.missingFunnelStages !== 1 ? 's' : ''} missing` : null,
          ])
        : 'No data yet',
    },
    {
      key: 'journey',
      label: 'Journey',
      status: deriveJourneyStrengthBand(journeyRows),
      detail: journeyRows ? `${journeyRows} paths${journeyLoops > 0 ? ` (${journeyLoops} with loops)` : ''}` : 'No data yet',
    },
    {
      key: 'experience',
      label: 'Experience',
      status: deriveExperienceBand(experiencePages),
      detail: experiencePages
        ? `${experiencePages} pages${avgEngagement !== null ? ` (avg ${avgEngagement}/100)` : ''}`
        : 'No data yet',
    },
    {
      key: 'ai_visibility',
      label: 'AI visibility',
      status: aiVisibility?.composite != null ? confidenceToStatus(aiVisibility.composite >= 75 ? 'High' : aiVisibility.composite >= 50 ? 'Medium' : 'Low') : 'Idle',
      detail: aiVisibility?.composite != null
        ? `Composite ${aiVisibility.composite}/100 · mentions ${aiVisibility.mentions ?? '—'}`
        : 'Awaiting snapshot-backed metrics',
    },
  ];
}
