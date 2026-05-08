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

function normalizeReferenceUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || s.startsWith('//')) return s.startsWith('//') ? `https:${s}` : s;
  if (s.startsWith('/')) return s;
  return `https://${s}`;
}

function referencesFromTopPages(telemetry, limit = 3) {
  const refs = [];
  for (const p of (telemetry?.topPages || []).slice(0, limit)) {
    const url = normalizeReferenceUrl(p?.url);
    if (!url) continue;
    const label = String(p?.url || url)
      .split('/')
      .filter(Boolean)
      .pop();
    refs.push({
      label: label || 'Page',
      url,
      reason: `${Number(p?.count || 0).toLocaleString()} views in telemetry rollups for this range.`,
    });
  }
  return refs;
}

function referencesFromJourney(journey, limit = 2) {
  const refs = [];
  for (const row of (journey?.rows || []).slice(0, limit)) {
    const url = normalizeReferenceUrl(row?.entryUrl || row?.exitUrl);
    if (!url) continue;
    refs.push({
      label: 'Visitor path',
      url,
      reason: `Recorded journey with ${Number(row?.stepCount || 0)} steps in this range.`,
    });
  }
  return refs;
}

function referencesFromExperience(experience, limit = 2) {
  const refs = [];
  for (const page of (experience?.pages || []).slice(0, limit)) {
    const url = normalizeReferenceUrl(page?.url);
    if (!url) continue;
    refs.push({
      label: 'Experience sample',
      url,
      reason:
        typeof page?.score === 'number'
          ? `Experience score ${page.score}/100 in this window.`
          : 'Experience diagnostics available for this page.',
    });
  }
  return refs;
}

export async function buildExecutiveSummary(input, extras = {}) {
  const llmMentions = extras?.llmMentions ?? null;
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
  const aiVisibilitySignals = llmMentions?.aiVisibility?.signals || [];
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
        signals: aiVisibilitySignals,
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

  const topPageRefs = referencesFromTopPages(telemetry, 4);
  const journeyRefs = referencesFromJourney(journey, 3);
  const experienceRefs = referencesFromExperience(experience, 3);

  const insights = [
    {
      question: 'Is the site gaining usable AI-search momentum?',
      answer:
        telemetry.totals.pageViews > 0
          ? `${telemetry.totals.pageViews.toLocaleString()} page views and ${telemetry.totals.searches.toLocaleString()} searches are represented in cached rollups for this range.`
          : 'No cached telemetry rollups are available for this range yet.',
      references: topPageRefs.length ? topPageRefs : referencesFromJourney(journey, 2),
    },
    {
      question: 'Are trust signals strong enough?',
      answer:
        authority.authorityScore > 0
          ? `Authority is currently ${authority.authorityScore}/100 with ${authority.trustSignals.length} trust signals represented.`
          : 'Authority signals are still building.',
      references: (() => {
        const fromTrust = (authority.trustSignals || [])
          .map((signal) => {
            const label = String(signal?.label || 'Trust signal');
            const value = signal?.value;
            const url = typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null;
            if (!url) return null;
            return { label, url, reason: 'Persisted trust signal evidence for this range.' };
          })
          .filter(Boolean);
        if (fromTrust.length) return fromTrust;
        return topPageRefs.slice(0, 2);
      })(),
    },
    {
      question: 'What needs attention first?',
      answer:
        searchDiagnostics.rows.length > 0
          ? 'Search diagnostics show user-query friction that should be reviewed before deeper content changes.'
          : experience.pages.length > 0
            ? 'Experience diagnostics are available; prioritize low-scoring pages first.'
            : 'No cached search or experience diagnostics are available yet.',
      references:
        searchDiagnostics.rows.length > 0
          ? topPageRefs
          : experienceRefs.length > 0
            ? experienceRefs
            : journeyRefs,
    },
    {
      question: 'Where are visitors moving across the site?',
      answer:
        journey.rows.length > 0
          ? `${journey.rows.length} distinct visitor paths are available; review loops and backtracks on high-traffic routes.`
          : 'Journey rollups are still sparse for this range — widen the date window once more telemetry is ingested.',
      references: journeyRefs.length ? journeyRefs : topPageRefs,
    },
    {
      question: 'Which pages should we protect first?',
      answer:
        coverage?.totals?.contentGaps > 0
          ? `Coverage shows ${coverage.totals.contentGaps} content gap${coverage.totals.contentGaps === 1 ? '' : 's'}; shore up missing intents before expanding net-new pages.`
          : 'Coverage signals look stable — continue monitoring as new pages ship.',
      references: topPageRefs.length ? topPageRefs.slice(0, 2) : experienceRefs,
    },
  ];

  const focusLanes = buildFocusLanes({
    telemetry,
    confusion,
    coverage,
    aiVisibility: aiVisibilityBlock,
    llmMentions,
  });

  return {
    range: telemetry.range,
    insights,
    aiVisibility: aiVisibilityBlock,
    signalChips,
    focusLanes,
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

function ensureUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.replace(/^\/+/, '')}`;
}

function severityForLlmLevel(level) {
  if (level === 'critical') return 'critical';
  if (level === 'warn') return 'warn';
  if (level === 'info') return 'watch';
  return 'good';
}

export function buildFocusLanes({ telemetry, confusion, coverage, aiVisibility, llmMentions }) {
  const performingWell = [];
  const seenPerforming = new Set();

  for (const page of (telemetry?.topPages || []).slice(0, 3)) {
    const url = ensureUrl(page?.url);
    if (!url || seenPerforming.has(url)) continue;
    seenPerforming.add(url);
    performingWell.push({
      id: `top:${url}`,
      label: String(page?.url || url),
      value: page?.count ? `${Number(page.count).toLocaleString()} views` : null,
      severity: 'good',
      source: 'telemetry.topPages',
      href: url,
    });
  }

  for (const page of (llmMentions?.summary?.topPages || []).slice(0, 2)) {
    const url = ensureUrl(page?.url);
    const label = String(page?.url || '').trim();
    if (!label) continue;
    const id = `ai-cited:${url || label}`;
    if (seenPerforming.has(id)) continue;
    seenPerforming.add(id);
    performingWell.push({
      id,
      label: `${label} (AI-cited)`,
      value: page?.count != null ? `${Number(page.count).toLocaleString()} citations` : null,
      severity: 'good',
      source: 'llmMentions.topPages',
      href: url || undefined,
    });
  }

  const needsAttention = [];

  for (const signal of (aiVisibility?.signals || []).slice(0, 4)) {
    if (!signal?.message) continue;
    if (signal.level === 'info' || signal.level === 'ok') continue;
    needsAttention.push({
      id: `ai:${signal.id || signal.message}`,
      label: signal.message,
      value: null,
      severity: severityForLlmLevel(signal.level),
      source: 'aiVisibility.signals',
      href: undefined,
    });
  }

  for (const item of (coverage?.priorityItems || []).slice(0, 2)) {
    needsAttention.push({
      id: `coverage:${item.id || item.label}`,
      label: String(item.label || 'Coverage gap'),
      value: item.severity ? String(item.severity) : null,
      severity: item.severity === 'critical' ? 'critical' : 'warn',
      source: 'coverage.priorityItems',
      href: ensureUrl(item.pages?.[0]) || undefined,
    });
  }

  for (const dead of (confusion?.signals?.deadEnds || []).slice(0, 2)) {
    const url = ensureUrl(dead.url);
    needsAttention.push({
      id: `dead:${url || dead.url}`,
      label: `Dead end: ${dead.url}`,
      value: dead.count != null ? `${Number(dead.count).toLocaleString()} hits` : null,
      severity: 'warn',
      source: 'confusion.deadEnds',
      href: url || undefined,
    });
  }

  const opportunities = (confusion?.signals?.repeatedSearches || []).slice(0, 3).map((item) => ({
    id: `repeat:${item.query}`,
    label: `Repeated search: ${item.query}`,
    value: item.count != null ? `${Number(item.count).toLocaleString()} repeats` : null,
    severity: 'watch',
    source: 'confusion.repeatedSearches',
    href: undefined,
  }));

  return {
    performingWell: {
      id: 'performing_well',
      label: 'Performing Well',
      description: 'Pages and AI citations showing strong engagement.',
      plainMeaning: 'These are working — protect or amplify them.',
      items: performingWell,
    },
    needsAttention: {
      id: 'needs_attention',
      label: 'Needs Attention',
      description: 'Risks and gaps that should be addressed first.',
      plainMeaning: 'These are hurting visitor experience right now.',
      items: needsAttention,
    },
    opportunities: {
      id: 'opportunities',
      label: 'Not Effective',
      description: 'Visitor effort that is not resolving — review or remove.',
      plainMeaning: 'These patterns are not producing good outcomes.',
      items: opportunities,
    },
  };
}
