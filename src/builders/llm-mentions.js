import { db } from '../db.js';

function iso(value) {
  return value ? new Date(value).toISOString() : null;
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

function confidenceFreshness(latestSnapshotAt) {
  return {
    state: latestSnapshotAt ? 'fresh' : 'missing',
    ageDays: null,
    weightMultiplier: latestSnapshotAt ? 1 : 0,
    stale: !latestSnapshotAt,
    summary: `Combined AI source snapshots. Latest refresh: ${
      latestSnapshotAt ? new Date(latestSnapshotAt).toLocaleString() : 'not available'
    }.`,
    lastUpdatedAt: latestSnapshotAt,
    sourceContext: 'mixed',
  };
}

function scoreBucket(score, redistributedWeight) {
  return {
    score,
    redistributedWeight,
    freshnessMultiplier: score === null ? 0 : 1,
    contribution: score === null ? null : score * redistributedWeight,
  };
}

function buildAiVisibility({ summary, authorityScore, latestSnapshotAt }) {
  const hasAnswerEvidence = (summary.searchExamples || []).length > 0;
  return {
    internal: {
      authorityScore,
      schemaCompletenessScore: null,
      confusionScore: null,
      coverageScore: null,
      aiSearchScore: null,
    },
    external: {
      mentions: summary.metrics.mentions,
      aiSearchVolume: summary.metrics.aiSearchVolume,
      impressions: summary.metrics.impressions,
      shareOfVoice: null,
      topDomains: summary.topDomains || [],
      topPages: summary.topPages || [],
      searchExamples: summary.searchExamples || [],
      competitorComparison: [],
      metrics: summary.metrics,
      lastUpdatedAt: summary.lastUpdatedAt,
    },
    composite: 0,
    narrative: 'Search evidence exists, but the brand is not being cited directly in sampled AI answers.',
    signals: [],
    breakdown: {
      reach: scoreBucket(null, 0),
      citationCoverage: scoreBucket(null, 0),
      competitivePosition: scoreBucket(null, 0),
      answerEvidence: scoreBucket(hasAnswerEvidence ? 0 : null, hasAnswerEvidence ? 90 : 0),
      internalReadiness: scoreBucket(0, 10),
    },
    freshness: confidenceFreshness(latestSnapshotAt),
    coverage: {
      aggregated_metrics: { endpoint: 'aggregated_metrics', matched: true, targetType: null, targetKey: null, fetchedAt: latestSnapshotAt, ageDays: null, freshness: latestSnapshotAt ? 'fresh' : 'missing', weightMultiplier: latestSnapshotAt ? 1 : 0, sourceContext: null },
      top_domains: { endpoint: 'top_domains', matched: true, targetType: null, targetKey: null, fetchedAt: latestSnapshotAt, ageDays: null, freshness: latestSnapshotAt ? 'fresh' : 'missing', weightMultiplier: latestSnapshotAt ? 1 : 0, sourceContext: null },
      top_pages: { endpoint: 'top_pages', matched: true, targetType: null, targetKey: null, fetchedAt: latestSnapshotAt, ageDays: null, freshness: latestSnapshotAt ? 'fresh' : 'missing', weightMultiplier: latestSnapshotAt ? 1 : 0, sourceContext: null },
      cross_aggregated_metrics: { endpoint: 'cross_aggregated_metrics', matched: false, targetType: null, targetKey: null, fetchedAt: null, ageDays: null, freshness: 'missing', weightMultiplier: 0, sourceContext: null },
      search: { endpoint: 'search', matched: hasAnswerEvidence, targetType: null, targetKey: null, fetchedAt: latestSnapshotAt, ageDays: null, freshness: hasAnswerEvidence ? 'fresh' : 'missing', weightMultiplier: hasAnswerEvidence ? 1 : 0, sourceContext: null },
    },
    sourceContext: 'mixed',
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

export async function buildLlmMentionsOverview({ siteId, days = 7, windowStart, windowEnd, sources = ['chat_gpt', 'google_ai_overviews'] }) {
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

  const [siteRows, authorityRows, rollups, observations, snapshots, prompts] = await Promise.all([
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
  ]);

  const latestSnapshotAt = iso(snapshots[0]?.fetched_at);
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

  const searchExamples = observations.length > 0
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

  return {
    siteId,
    siteDomain: siteRows[0]?.domain || null,
    days: Number(days || 7),
    sources,
    summary,
    aiVisibility: buildAiVisibility({
      summary,
      authorityScore: authorityRows[0]?.authority_score ?? null,
      latestSnapshotAt,
    }),
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
            locationCode: 2840,
            languageCode: 'en',
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
      summary: { comparison: collectRollupList(rollups, 'comparison'), lastUpdatedAt: iso(snapshots[0]?.fetched_at) },
    },
    snapshots: snapshots.map((r) => ({
      endpoint: r.endpoint,
      targetKey: r.target_key,
      source: r.source,
      sourceContext: r.source_context,
      fetchedAt: iso(r.fetched_at),
      expiresAt: iso(r.expires_at),
    })),
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

  return {
    siteId,
    source,
    locationCode: 2840,
    languageCode: 'en',
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
          locationCode: 2840,
          languageCode: 'en',
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

  return {
    siteId,
    source,
    locationCode: 2840,
    languageCode: 'en',
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
