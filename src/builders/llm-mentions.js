import { db } from '../db.js';
import { loadLatestSiteScoreSnapshot } from '../lib/site-score-snapshot.js';
import {
  LLM_INTERNAL_WEIGHT,
  LLM_VISIBILITY_WEIGHTS,
  buildInternalBucket,
  buildWeightedBucket,
  clampScore,
  compositeFromBreakdown,
  computeAnswerEvidenceFromExamples,
  computeCitationCoverageScore,
  computeCompetitiveScore,
  computeInternalReadinessScore,
  computeReachScore,
  getScoreBand,
  getScoreSeverity,
  hasPositiveLlmMetrics,
  isSiteDomainMatch,
} from '../lib/scoring.js';
import { buildEvidenceSuggestions } from '../lib/answer-evidence.js';

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function ageDaysFrom(now, iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const diff = (now.getTime() - ms) / 86_400_000;
  return diff < 0 ? 0 : diff;
}

function freshnessState(ageDays) {
  if (ageDays === null) return 'missing';
  if (ageDays > 30) return 'expired';
  if (ageDays > 7) return 'stale';
  return 'fresh';
}

function freshnessMultiplier(ageDays) {
  if (ageDays === null) return 0;
  if (ageDays > 30) return 0;
  if (ageDays > 7) return 0.5;
  return 1;
}

function endpointCoverage(endpoint, snapshot, now) {
  const ageDays = ageDaysFrom(now, snapshot?.fetchedAt || null);
  return {
    endpoint,
    matched: Boolean(snapshot),
    targetType: snapshot?.targetType ?? null,
    targetKey: snapshot?.targetKey ?? null,
    fetchedAt: snapshot?.fetchedAt || null,
    ageDays,
    freshness: freshnessState(ageDays),
    weightMultiplier: freshnessMultiplier(ageDays),
    sourceContext: snapshot?.sourceContext || null,
  };
}

function summarizeFreshness(latestAt, sourceContext, now) {
  const ageDays = ageDaysFrom(now, latestAt);
  const state = freshnessState(ageDays);
  const ageRound = ageDays !== null ? Math.round(ageDays) : null;
  let summary;
  if (state === 'missing') {
    summary = 'No scoring-eligible LLM Mentions snapshots are available for this site yet.';
  } else if (state === 'expired') {
    summary = `Latest LLM Mentions evidence is older than 30 days${ageRound != null ? ` (${ageRound} days old)` : ''} and is excluded from scoring.`;
  } else if (state === 'stale') {
    summary = `Latest LLM Mentions evidence is ${ageRound != null ? `${ageRound} days old` : 'stale'} and counts at half weight.`;
  } else if (sourceContext === 'manual') {
    summary = 'Latest LLM Mentions score is driven by manual site-matching snapshots.';
  } else if (sourceContext === 'mixed') {
    summary = 'Latest LLM Mentions score blends scheduled and manual site-matching snapshots.';
  } else {
    summary = 'Latest LLM Mentions score is fresh and driven by stored site-matching snapshots.';
  }
  return {
    state,
    ageDays,
    weightMultiplier: freshnessMultiplier(ageDays),
    stale: state === 'stale' || state === 'expired',
    summary,
    lastUpdatedAt: latestAt || null,
    sourceContext: sourceContext || null,
  };
}

function summarizeSourceContexts(rows = []) {
  const groups = new Set();
  for (const row of rows) {
    const ctx = row?.sourceContext;
    if (!ctx) continue;
    if (ctx === 'manual' || ctx === 'suggestion') groups.add('manual');
    else groups.add('cron');
  }
  if (groups.size === 0) return null;
  if (groups.size > 1) return 'mixed';
  return groups.has('manual') ? 'manual' : 'cron';
}

function buildSignals(internal, external, breakdown, freshness) {
  const signals = [];
  const mentions = external?.mentions ?? 0;
  const aiVolume = external?.aiSearchVolume ?? 0;
  const authority = internal?.authorityScore ?? null;
  const schema = internal?.schemaCompletenessScore ?? null;

  if (freshness?.state === 'expired') {
    signals.push({ id: 'expired_snapshots', level: 'warn', message: 'Latest LLM Mentions snapshots are older than 30 days and are excluded from score weighting.' });
  } else if (freshness?.state === 'stale') {
    signals.push({ id: 'stale_snapshots', level: 'info', message: 'Latest LLM Mentions snapshots are older than 7 days and only count at half weight.' });
  }

  if (mentions <= 0 && aiVolume > 50) {
    signals.push({ id: 'zero_mentions_high_demand', level: 'critical', message: `AI search volume is ${Math.round(aiVolume)} but the brand has zero captured mentions — major gap between demand and visibility.` });
  }

  if (authority !== null && authority >= 60 && mentions <= 0) {
    signals.push({ id: 'strong_authority_weak_mentions', level: 'warn', message: `Authority score is ${Math.round(authority)}/100 but the brand is not surfacing in LLM answers. Amplify first-party schema + sources.` });
  }

  if (schema !== null && schema < 50 && mentions > 0) {
    signals.push({ id: 'weak_schema_with_mentions', level: 'warn', message: `Brand is being mentioned (${mentions}) but schema completeness is only ${Math.round(schema)}%. LLMs may misattribute or drop sources.` });
  }

  if (typeof external?.shareOfVoice === 'number' && external.shareOfVoice < 0.15 && (external.competitorComparison || []).length > 1) {
    signals.push({ id: 'low_share_of_voice', level: 'warn', message: `Share of voice vs competitors is only ${Math.round(external.shareOfVoice * 100)}%. Prioritize authority and FAQ coverage.` });
  }

  if (breakdown?.answerEvidence?.score === 0 && (external?.searchExamples || []).length > 0) {
    signals.push({ id: 'search_without_self_citations', level: 'warn', message: 'Search evidence exists, but the brand is not being cited directly in sampled AI answers.' });
  }

  if (signals.length === 0) {
    signals.push({ id: 'baseline', level: 'info', message: 'No critical visibility gaps detected in the most recent site-matching snapshot set.' });
  }

  return signals;
}

function buildNarrative(composite, internal, external, freshness) {
  if (composite === null) {
    return 'AI Visibility is not yet computable — no site-matching DataForSEO snapshots or internal readiness signals are available for this site.';
  }
  const mentions = external?.mentions ?? 0;
  const authority = internal?.authorityScore ?? 0;
  const freshnessSuffix =
    freshness?.state === 'stale'
      ? ' Snapshot freshness is aging, so the score is partially discounted.'
      : freshness?.state === 'expired'
        ? ' Current score excludes expired snapshots older than 30 days.'
        : '';
  if (composite >= 75) return `Strong AI Visibility (${composite}/100). ${mentions} tracked mentions and ${authority}/100 authority are compounding — maintain schema, keep refreshing topical coverage, and protect the pages already cited by AI systems.${freshnessSuffix}`;
  if (composite >= 50) return `Moderate AI Visibility (${composite}/100). Authority is ${authority}/100 and the brand is appearing in AI snapshots, but citation coverage and answer evidence still need tightening.${freshnessSuffix}`;
  if (composite >= 25) return `Low AI Visibility (${composite}/100). External AI surfaces are not picking up the brand reliably; focus on authoritative, schema-rich pages and content aligned to cited prompts.${freshnessSuffix}`;
  return `Critical AI Visibility gap (${composite}/100). Brand visibility in AI answers is still weak relative to observed demand, so the next lift should come from technical trust fixes and high-signal content expansion.${freshnessSuffix}`;
}

function sourceFromSnapshot(row) {
  const platform = row?.response_data?.tasks?.[0]?.data?.platform || row?.request_params?.platform;
  if (platform === 'google') return 'google_ai_overviews';
  if (platform === 'chat_gpt') return 'chat_gpt';
  return row?.source || 'dataforseo';
}

function emptyMetrics() {
  return { mentions: null, aiSearchVolume: null, impressions: null };
}

function metricFromRollups(rollups, key) {
  const values = rollups
    .map((row) => row.payload?.[key])
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function buildSearchExampleFromSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    question: 'Prompt',
    answerPreview: 'No answer preview available',
    platform: sourceFromSnapshot(snapshot),
    model: sourceFromSnapshot(snapshot),
    source: sourceFromSnapshot(snapshot),
    citedDomains: [],
    retrievedDomains: [],
    brandEntities: [],
    fanOutQueries: [],
    sourceUrls: [],
  };
}

function latestBySource(rows, sources) {
  return sources
    .map((source) => rows.find((row) => sourceFromSnapshot(row) === source))
    .filter(Boolean);
}

function buildShareOfVoice(siteDomain, comparison = []) {
  if (!siteDomain || !Array.isArray(comparison) || comparison.length === 0) return null;
  const self = comparison.find((row) => isSiteDomainMatch(row?.target || row?.domain, siteDomain));
  if (!self) return null;
  if (typeof self.shareOfVoice === 'number' && Number.isFinite(self.shareOfVoice)) return self.shareOfVoice;
  const total = comparison.reduce((sum, row) => sum + Number(row?.aiSearchVolume || row?.mentions || 0), 0);
  if (total <= 0) return null;
  const selfTotal = Number(self.aiSearchVolume || self.mentions || 0);
  return selfTotal > 0 ? selfTotal / total : null;
}

function buildSnapshotMap(snapshots = []) {
  const map = new Map();
  for (const row of snapshots) {
    if (!row?.endpoint) continue;
    const existing = map.get(row.endpoint);
    if (!existing || (row.fetchedAt && existing.fetchedAt && new Date(row.fetchedAt) > new Date(existing.fetchedAt))) {
      map.set(row.endpoint, row);
    }
  }
  return map;
}

function buildAiVisibility({
  summary,
  siteDomain,
  competitorComparison = [],
  internalInputs = {},
  snapshotsByEndpoint = new Map(),
  latestSnapshotAt = null,
  freshnessSourceContext = null,
  now = new Date(),
}) {
  const internal = {
    authorityScore: internalInputs.authorityScore ?? null,
    schemaCompletenessScore: internalInputs.schemaCompletenessScore ?? null,
    confusionScore: internalInputs.confusionScore ?? null,
    coverageScore: internalInputs.coverageScore ?? null,
    aiSearchScore: internalInputs.aiSearchScore ?? null,
  };

  const shareOfVoice = buildShareOfVoice(siteDomain, competitorComparison);
  const external = {
    mentions: summary.metrics.mentions,
    aiSearchVolume: summary.metrics.aiSearchVolume,
    impressions: summary.metrics.impressions,
    shareOfVoice,
    topDomains: summary.topDomains || [],
    topPages: summary.topPages || [],
    searchExamples: summary.searchExamples || [],
    competitorComparison,
    metrics: summary.metrics,
    lastUpdatedAt: summary.lastUpdatedAt,
  };

  const reachScore = computeReachScore(external.metrics);
  const citationScore = computeCitationCoverageScore({
    topDomains: external.topDomains,
    topPages: external.topPages,
    siteDomain,
  });
  const competitiveScore = computeCompetitiveScore(external.shareOfVoice);
  const answerEvidenceScore = computeAnswerEvidenceFromExamples(external.searchExamples, siteDomain);
  const internalReadiness = computeInternalReadinessScore(internal);

  const coverage = {
    aggregated_metrics: endpointCoverage('aggregated_metrics', snapshotsByEndpoint.get('aggregated_metrics'), now),
    top_domains: endpointCoverage('top_domains', snapshotsByEndpoint.get('top_domains'), now),
    top_pages: endpointCoverage('top_pages', snapshotsByEndpoint.get('top_pages'), now),
    cross_aggregated_metrics: endpointCoverage('cross_aggregated_metrics', snapshotsByEndpoint.get('cross_aggregated_metrics'), now),
    search: endpointCoverage('search', snapshotsByEndpoint.get('search'), now),
  };

  const llmAvailableBaseWeight =
    (reachScore !== null ? LLM_VISIBILITY_WEIGHTS.reach : 0) +
    (citationScore !== null ? LLM_VISIBILITY_WEIGHTS.citationCoverage : 0) +
    (competitiveScore !== null ? LLM_VISIBILITY_WEIGHTS.competitivePosition : 0) +
    (answerEvidenceScore !== null ? LLM_VISIBILITY_WEIGHTS.answerEvidence : 0);

  const reachFreshness = coverage.aggregated_metrics.weightMultiplier;
  const citationFreshness = Math.max(coverage.top_domains.weightMultiplier, coverage.top_pages.weightMultiplier);
  const competitiveFreshness = coverage.cross_aggregated_metrics.weightMultiplier;
  const searchFreshness = coverage.search.weightMultiplier;

  const breakdown = {
    reach: buildWeightedBucket(reachScore, LLM_VISIBILITY_WEIGHTS.reach, llmAvailableBaseWeight, reachFreshness || 1),
    citationCoverage: buildWeightedBucket(citationScore, LLM_VISIBILITY_WEIGHTS.citationCoverage, llmAvailableBaseWeight, citationFreshness || 1),
    competitivePosition: buildWeightedBucket(competitiveScore, LLM_VISIBILITY_WEIGHTS.competitivePosition, llmAvailableBaseWeight, competitiveFreshness || 1),
    answerEvidence: buildWeightedBucket(answerEvidenceScore, LLM_VISIBILITY_WEIGHTS.answerEvidence, llmAvailableBaseWeight, searchFreshness || 1),
    internalReadiness: buildInternalBucket(internalReadiness),
  };

  const rawComposite = compositeFromBreakdown(breakdown);
  const evidenceFallback = computeReachScore(external.metrics);
  const composite =
    rawComposite === 0 && hasPositiveLlmMetrics(external.metrics) && evidenceFallback !== null
      ? evidenceFallback
      : rawComposite;

  const sourceContext = freshnessSourceContext || summarizeSourceContexts(Array.from(snapshotsByEndpoint.values()));
  const freshness = summarizeFreshness(latestSnapshotAt, sourceContext, now);
  const signals = buildSignals(internal, external, breakdown, freshness);
  const narrative = buildNarrative(composite, internal, external, freshness);

  return {
    internal,
    external,
    composite,
    band: getScoreBand(composite),
    severity: getScoreSeverity(composite),
    narrative,
    signals,
    breakdown,
    freshness,
    coverage,
    sourceContext,
    weights: { ...LLM_VISIBILITY_WEIGHTS, internalReadiness: LLM_INTERNAL_WEIGHT },
  };
}

function promptRowToPayload(row, latestObservation = null) {
  return {
    id: row.id,
    label: row.label,
    query: row.query,
    bucket: row.bucket,
    intent: row.intent,
    priority: row.priority,
    active: row.active,
    locationCode: row.location_code,
    languageCode: row.language_code,
    source: row.source,
    seeded: row.seeded,
    latestObservation,
    recentObservations: latestObservation ? [latestObservation] : [],
  };
}

export async function buildLlmMentionsOverview({
  siteId,
  days = 7,
  windowStart,
  windowEnd,
  sources = ['chat_gpt', 'google_ai_overviews'],
  internalInputs: internalInputsOverride = null,
}) {
  const sql = db();
  if (!siteId) {
    const error = new Error('siteId is required for LLM Mentions overview');
    error.statusCode = 400;
    throw error;
  }

  let since;
  let until = new Date();
  if (windowStart && windowEnd) {
    since = new Date(windowStart);
    until = new Date(windowEnd);
  } else {
    since = new Date();
    since.setDate(since.getDate() - Number(days || 7));
  }

  const [siteRows, authorityRows, rollups, observations, snapshots, prompts, schemaEvents, confusionRows, coverageRows] = await Promise.all([
    sql`SELECT domain FROM sites WHERE id = ${siteId}::uuid LIMIT 1`,
    sql`
      SELECT authority_score
      FROM authority_signals
      WHERE site_id = ${siteId}::uuid
      ORDER BY created_at DESC
      LIMIT 1
    `,
    sql`
      SELECT day, rollup_type, source, payload, updated_at
      FROM llm_mentions_rollups_daily
      WHERE site_id = ${siteId}::uuid
        AND source = ANY(${sources}::text[])
        AND day >= ${since}
        AND day <= ${until}
      ORDER BY day ASC
    `,
    sql`
      SELECT id, question, answer_preview, cited_domains, retrieved_domains, brand_entities,
             fan_out_queries, site_mentioned, site_cited, outcome, mentions,
             ai_search_volume, impressions, source, fetched_at
      FROM llm_mentions_prompt_observations
      WHERE site_id = ${siteId}::uuid
        AND source = ANY(${sources}::text[])
        AND fetched_at >= ${since}
        AND fetched_at <= ${until}
      ORDER BY fetched_at DESC
      LIMIT 100
    `,
    sql`
      SELECT endpoint, target_key, response_data, status, source, source_context, fetched_at, expires_at
      FROM llm_mentions_snapshots
      WHERE site_id = ${siteId}::uuid
        AND status = 'success'
        AND fetched_at >= ${since}
        AND fetched_at <= ${until}
      ORDER BY fetched_at DESC
      LIMIT 50
    `,
    sql`
      SELECT id, label, query, bucket, intent, priority, active, location_code, language_code, source, seeded, created_at
      FROM llm_mentions_tracked_prompts
      WHERE site_id = ${siteId}::uuid
        AND active = true
      ORDER BY created_at ASC
      LIMIT 100
    `,
    sql`
      SELECT metrics
      FROM telemetry_events
      WHERE site_id = ${siteId}::uuid
        AND timestamp >= ${since}
        AND timestamp <= ${until}
      LIMIT 200
    `.catch(() => []),
    sql`
      SELECT score
      FROM confusion_signals
      WHERE site_id = ${siteId}::uuid
        AND window_end >= ${since}
        AND window_start <= ${until}
      LIMIT 50
    `.catch(() => []),
    sql`
      SELECT gaps
      FROM coverage_signals
      WHERE site_id = ${siteId}::uuid
        AND window_end >= ${since}
        AND window_start <= ${until}
      LIMIT 50
    `.catch(() => []),
  ]);

  const snapshotsList = snapshots.map((r) => ({
    endpoint: r.endpoint,
    targetKey: r.target_key,
    source: r.source,
    sourceContext: r.source_context,
    fetchedAt: iso(r.fetched_at),
    expiresAt: iso(r.expires_at),
  }));
  const snapshotsByEndpoint = buildSnapshotMap(snapshotsList);
  const latestSnapshotAt = iso(snapshots[0]?.fetched_at);
  const freshnessSourceContext = summarizeSourceContexts(snapshotsList);

  const latestSearchSnapshots = latestBySource(snapshots.filter((row) => row.endpoint === 'search'), sources);
  const fallbackSearchExamples = latestSearchSnapshots
    .map(buildSearchExampleFromSnapshot)
    .filter(Boolean)
    .slice(0, 6);

  const metrics = observations.length > 0
    ? observations.reduce(
        (sum, r) => ({
          mentions: sum.mentions + (r.mentions || 0),
          aiSearchVolume: sum.aiSearchVolume + (r.ai_search_volume || 0),
          impressions: sum.impressions + (r.impressions || 0),
        }),
        { mentions: 0, aiSearchVolume: 0, impressions: 0 }
      )
    : {
        mentions: metricFromRollups(rollups, 'mentions'),
        aiSearchVolume: metricFromRollups(rollups, 'aiSearchVolume'),
        impressions: metricFromRollups(rollups, 'impressions'),
      };

  const counts = observations.reduce(
    (sum, r) => {
      sum[r.outcome] = (sum[r.outcome] || 0) + 1;
      return sum;
    },
    { cited: 0, retrieved_not_cited: 0, not_seen: 0 }
  );

  const siteDomain = siteRows[0]?.domain || null;
  const baseSearchExamples = observations.length > 0
    ? observations.slice(0, 6).map((r) => ({
        question: r.question,
        answerPreview: r.answer_preview,
        platform: r.source,
        model: r.source,
        source: r.source,
        outcome: r.outcome,
        citedDomains: r.cited_domains || [],
        retrievedDomains: r.retrieved_domains || [],
        brandEntities: r.brand_entities || [],
        fanOutQueries: r.fan_out_queries || [],
        sourceUrls: [],
      }))
    : fallbackSearchExamples;

  const searchExamples = baseSearchExamples.map((example) => ({
    ...example,
    suggestions: buildEvidenceSuggestions(example, siteDomain),
  }));

  const competitorComparison = collectRollupList(rollups, 'comparison');

  const summary = {
    metrics,
    topPages: collectRollupList(rollups, 'topPages'),
    topDomains: collectRollupList(rollups, 'topDomains'),
    searchExamples,
    platformBreakdown: sources.map((source) => {
      const rows = observations.filter((r) => r.source === source);
      const sourceRollups = rollups.filter((r) => r.source === source);
      return {
        source,
        mentions: rows.length ? rows.reduce((sum, r) => sum + (r.mentions || 0), 0) : metricFromRollups(sourceRollups, 'mentions'),
        aiSearchVolume: rows.length ? rows.reduce((sum, r) => sum + (r.ai_search_volume || 0), 0) : metricFromRollups(sourceRollups, 'aiSearchVolume'),
        impressions: rows.length ? rows.reduce((sum, r) => sum + (r.impressions || 0), 0) : metricFromRollups(sourceRollups, 'impressions'),
      };
    }),
    trend: rollups
      .filter((r) => r.rollup_type === 'summary')
      .map((r) => ({ day: iso(r.day)?.slice(0, 10), source: r.source, metrics: r.payload || emptyMetrics() })),
    lastUpdatedAt: iso(observations[0]?.fetched_at || snapshots[0]?.fetched_at),
  };

  const internalInputs = internalInputsOverride || deriveInternalInputs({
    authorityScore: authorityRows[0]?.authority_score ?? null,
    schemaEvents,
    confusionRows,
    coverageRows,
  });

  let aiVisibility = buildAiVisibility({
    summary,
    siteDomain,
    competitorComparison,
    internalInputs,
    snapshotsByEndpoint,
    latestSnapshotAt,
    freshnessSourceContext,
  });
  const scoreSnapshot = await loadLatestSiteScoreSnapshot({ siteId, start: since, end: until });
  if (scoreSnapshot) {
    const snapshotScores = scoreSnapshot.scores || {};
    const snapshotSources = scoreSnapshot.source_scores || {};
    aiVisibility = {
      ...aiVisibility,
      composite: Number(snapshotScores.overallAiVisibility || 0),
      band: getScoreBand(Number(snapshotScores.overallAiVisibility || 0)),
      severity: getScoreSeverity(Number(snapshotScores.overallAiVisibility || 0)),
      narrative: `AI visibility is ${Number(snapshotScores.overallAiVisibility || 0)}/100 from ${scoreSnapshot.model_version}.`,
      internal: {
        ...aiVisibility.internal,
        authorityScore: Number(snapshotScores.siteAuthority || aiVisibility.internal?.authorityScore || 0),
        schemaCompletenessScore: scoreSnapshot.evidence?.schema?.completenessScore ?? aiVisibility.internal?.schemaCompletenessScore ?? null,
      },
      external: {
        ...aiVisibility.external,
        mentions: Number(snapshotScores.mentions || 0),
        metrics: {
          ...aiVisibility.external.metrics,
          mentions: Number(snapshotScores.mentions || 0),
          citations: Number(snapshotScores.citations || 0),
          citedPages: Number(snapshotScores.citedPages || 0),
        },
      },
      signals: Object.entries(snapshotSources).map(([source, score]) => ({
        id: `${source}_score_snapshot`,
        level: Number(score || 0) >= 40 ? 'info' : 'warn',
        message: `${source} visibility is ${Number(score || 0)}/100.`,
      })),
      scoreSnapshot: {
        id: scoreSnapshot.id,
        modelVersion: scoreSnapshot.model_version,
        generatedAt: scoreSnapshot.created_at ? new Date(scoreSnapshot.created_at).toISOString() : null,
        dataCompleteness: scoreSnapshot.evidence?.dataCompleteness || null,
        freshness: scoreSnapshot.evidence?.freshness || null,
      },
    };
  }

  const defaultPrompt = prompts[0] || null;
  const defaultLocationCode = defaultPrompt?.location_code ?? null;
  const defaultLanguageCode = defaultPrompt?.language_code ?? null;

  return {
    siteId,
    siteDomain,
    days: Number(days || 7),
    sources,
    summary,
    aiVisibility,
    promptIntelligence: {
      summary: { counts, totalActivePrompts: observations.length > 0 ? observations.length : prompts.length },
      prompts: observations.length > 0
        ? observations.map((r) => ({
            id: r.id,
            label: r.question,
            query: r.question,
            bucket: 'tracked',
            intent: 'tracked',
            priority: 'medium',
            active: true,
            locationCode: defaultLocationCode,
            languageCode: defaultLanguageCode,
            source: r.source,
            seeded: false,
            latestObservation: {
              id: r.id,
              question: r.question,
              answerPreview: r.answer_preview,
              citedDomains: r.cited_domains || [],
              retrievedDomains: r.retrieved_domains || [],
              brandEntities: r.brand_entities || [],
              fanOutQueries: r.fan_out_queries || [],
              siteMentioned: r.site_mentioned,
              siteCited: r.site_cited,
              outcome: r.outcome,
              mentions: r.mentions,
              aiSearchVolume: r.ai_search_volume,
              impressions: r.impressions,
              source: r.source,
              fetchedAt: iso(r.fetched_at),
            },
            recentObservations: [],
          }))
        : prompts.map((prompt) => promptRowToPayload(prompt)),
    },
    sourceGap: {
      summary: {
        counts: {
          protect: counts.cited || 0,
          optimize: counts.retrieved_not_cited || 0,
          create: counts.not_seen || 0,
        },
      },
      opportunities: [],
      pageActions: [],
    },
    competitors: {
      summary: { comparison: competitorComparison, lastUpdatedAt: iso(snapshots[0]?.fetched_at) },
    },
    snapshots: snapshotsList,
  };
}

function parseMetricNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function deriveInternalInputs({ authorityScore, schemaEvents = [], confusionRows = [], coverageRows = [] }) {
  const completenessValues = [];
  const aiSearchValues = [];
  for (const event of schemaEvents) {
    const m = event?.metrics;
    if (!m || typeof m !== 'object') continue;
    const completeness = parseMetricNumber(m['ai.schemaCompleteness']);
    const aiSearch = parseMetricNumber(m['ai.searchVisibility']);
    if (completeness !== null) completenessValues.push(completeness);
    if (aiSearch !== null) aiSearchValues.push(aiSearch);
  }
  const schemaCompletenessScore = completenessValues.length
    ? clampScore(Math.round((completenessValues.reduce((s, v) => s + v, 0) / completenessValues.length) * 100))
    : null;
  const aiSearchScore = aiSearchValues.length
    ? clampScore(Math.round((aiSearchValues.reduce((s, v) => s + v, 0) / aiSearchValues.length) * 100))
    : null;
  const confusionAvg = confusionRows.length
    ? clampScore(Math.round(confusionRows.reduce((s, r) => s + Number(r.score || 0), 0) / confusionRows.length))
    : null;
  const allGaps = coverageRows.flatMap((r) => (Array.isArray(r.gaps) ? r.gaps : []));
  const coverageScore = coverageRows.length
    ? clampScore(Math.max(0, 100 - allGaps.length * 8))
    : null;
  return {
    authorityScore: authorityScore ?? null,
    schemaCompletenessScore,
    confusionScore: confusionAvg,
    coverageScore,
    aiSearchScore,
  };
}

export async function buildLlmMentionsTrends({ siteId, source = 'chat_gpt', days = 7, rollupType = 'summary' }) {
  const sql = db();
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }

  const since = new Date();
  since.setDate(since.getDate() - Number(days || 7));

  const rows = await sql`
    SELECT day, rollup_type, source, payload, updated_at
    FROM llm_mentions_rollups_daily
    WHERE site_id = ${siteId}::uuid
      AND source = ${source}
      AND rollup_type = ${rollupType}
      AND day >= ${since}
    ORDER BY day ASC
  `;

  return {
    siteId,
    source,
    days,
    rollupType,
    trend: rows.map((r) => ({
      day: iso(r.day)?.slice(0, 10),
      source: r.source,
      metrics: r.payload,
    })),
  };
}

export async function buildLlmMentionsCompetitors({ siteId, source = 'chat_gpt' }) {
  const sql = db();
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }

  const rollups = await sql`
    SELECT day, payload
    FROM llm_mentions_rollups_daily
    WHERE site_id = ${siteId}::uuid
      AND source = ${source}
      AND rollup_type = 'competitors'
    ORDER BY day DESC
    LIMIT 30
  `;

  const snapshots = await sql`
    SELECT response_data, fetched_at
    FROM llm_mentions_snapshots
    WHERE site_id = ${siteId}::uuid
      AND endpoint = 'top_domains'
      AND status = 'success'
    ORDER BY fetched_at DESC
    LIMIT 5
  `;

  return {
    siteId,
    source,
    comparison: collectRollupList(rollups, 'comparison'),
    topDomains: collectRollupList(rollups, 'topDomains'),
    lastUpdatedAt: iso(snapshots[0]?.fetched_at),
  };
}

export async function buildLlmMentionsPromptIntelligence({ siteId, source = 'chat_gpt' }) {
  const sql = db();
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }

  const [observations, prompts] = await Promise.all([
    sql`
      SELECT id, question, answer_preview, cited_domains, retrieved_domains,
             brand_entities, fan_out_queries, site_mentioned, site_cited,
             outcome, mentions, ai_search_volume, impressions, source, fetched_at
      FROM llm_mentions_prompt_observations
      WHERE site_id = ${siteId}::uuid
        AND source = ${source}
      ORDER BY fetched_at DESC
      LIMIT 50
    `,
    sql`
      SELECT id, label, query, bucket, intent, priority, active, location_code, language_code, source, seeded, created_at
      FROM llm_mentions_tracked_prompts
      WHERE site_id = ${siteId}::uuid
        AND active = true
        AND source = ${source}
      ORDER BY created_at ASC
      LIMIT 100
    `,
  ]);

  const counts = observations.reduce(
    (sum, r) => {
      sum[r.outcome] = (sum[r.outcome] || 0) + 1;
      return sum;
    },
    { cited: 0, retrieved_not_cited: 0, not_seen: 0 }
  );

  const defaultPrompt = prompts[0] || null;
  const defaultLocationCode = defaultPrompt?.location_code ?? null;
  const defaultLanguageCode = defaultPrompt?.language_code ?? null;

  return {
    siteId,
    source,
    locationCode: defaultLocationCode,
    languageCode: defaultLanguageCode,
    summary: { counts, totalActivePrompts: observations.length > 0 ? observations.length : prompts.length },
    prompts: observations.length > 0
      ? observations.map((r) => ({
          id: r.id,
          label: r.question,
          query: r.question,
          bucket: 'tracked',
          intent: 'tracked',
          priority: 'medium',
          active: true,
          locationCode: defaultLocationCode,
          languageCode: defaultLanguageCode,
          source: r.source,
          seeded: false,
          latestObservation: {
            id: r.id,
            question: r.question,
            answerPreview: r.answer_preview,
            citedDomains: r.cited_domains || [],
            retrievedDomains: r.retrieved_domains || [],
            brandEntities: r.brand_entities || [],
            fanOutQueries: r.fan_out_queries || [],
            siteMentioned: r.site_mentioned,
            siteCited: r.site_cited,
            outcome: r.outcome,
            mentions: r.mentions,
            aiSearchVolume: r.ai_search_volume,
            impressions: r.impressions,
            source: r.source,
            fetchedAt: iso(r.fetched_at),
          },
          recentObservations: [],
        }))
      : prompts.map((prompt) => promptRowToPayload(prompt)),
  };
}

export async function buildLlmMentionsSourceGap({ siteId, source = 'chat_gpt' }) {
  const sql = db();
  if (!siteId) {
    const error = new Error('siteId is required');
    error.statusCode = 400;
    throw error;
  }

  const observations = await sql`
    SELECT outcome, question, site_mentioned, site_cited
    FROM llm_mentions_prompt_observations
    WHERE site_id = ${siteId}::uuid
      AND source = ${source}
    ORDER BY fetched_at DESC
    LIMIT 100
  `;

  const counts = observations.reduce(
    (sum, r) => {
      if (r.outcome === 'cited') sum.protect++;
      else if (r.outcome === 'retrieved_not_cited') sum.optimize++;
      else sum.create++;
      return sum;
    },
    { protect: 0, optimize: 0, create: 0 }
  );

  const [defaultPrompt] = await sql`
    SELECT location_code, language_code
    FROM llm_mentions_tracked_prompts
    WHERE site_id = ${siteId}::uuid
      AND active = true
    ORDER BY created_at ASC
    LIMIT 1
  `;

  return {
    siteId,
    source,
    locationCode: defaultPrompt?.location_code ?? null,
    languageCode: defaultPrompt?.language_code ?? null,
    summary: { counts },
    opportunities: observations
      .filter((r) => r.outcome !== 'cited')
      .slice(0, 10)
      .map((r) => ({ question: r.question, outcome: r.outcome })),
    pageActions: [],
  };
}

function collectRollupList(rows, property) {
  const out = [];
  for (const row of rows) {
    const value = row.payload?.[property];
    if (Array.isArray(value)) out.push(...value);
  }
  return out.slice(0, 10);
}
