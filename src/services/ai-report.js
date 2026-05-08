import { assertSiteAccess, getUserContext } from '../access.js';
import {
  buildCacheIdentity,
  getCacheRow,
  isCacheStale,
  serializeCacheRow,
  upsertCacheRow,
} from '../cache.js';
import { computedFreshness, missingFreshness, ok, responseEnvelope } from '../contracts.js';
import { ttlForModule } from '../types.js';
import { parseDashboardContext, readDashboardReportBundle } from './dashboard.js';

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_TEMPERATURE = Number.isFinite(Number(process.env.OPENAI_TEMPERATURE))
  ? Number(process.env.OPENAI_TEMPERATURE)
  : 0.7;
const DEFAULT_MAX_TOKENS = Number.isFinite(Number(process.env.OPENAI_MAX_TOKENS))
  ? Number(process.env.OPENAI_MAX_TOKENS)
  : 2000;
const OPENAI_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';

function summarizeBundleForPrompt(bundle, range) {
  const telemetry = bundle?.telemetry || null;
  const confusion = bundle?.confusion || null;
  const authority = bundle?.authority || null;
  const schema = bundle?.schema || null;
  const coverage = bundle?.coverage || null;
  const executive = bundle?.executive || bundle?.executiveSummary || null;
  const llm = bundle?.llmMentions || null;
  const siteDetail = bundle?.siteDetail || null;

  return {
    site: siteDetail?.site || null,
    range,
    telemetry: telemetry
      ? {
          visits: telemetry?.totals?.visits || 0,
          pageViews: telemetry?.totals?.pageViews || 0,
          searches: telemetry?.totals?.searches || 0,
          trendPct: telemetry?.trendPct || null,
          trendPctLabel: telemetry?.trendPctLabel || null,
          topPages: (telemetry?.topPages || []).slice(0, 5),
          topIntents: (telemetry?.topIntents || []).slice(0, 5),
        }
      : null,
    confusion: confusion
      ? {
          repeatedSearches: confusion?.totals?.repeatedSearches || 0,
          deadEnds: confusion?.totals?.deadEnds || 0,
          dropOffs: confusion?.totals?.dropOffs || 0,
          intentMismatches: confusion?.totals?.intentMismatches || 0,
          recommendedFixes: confusion?.recommendedFixes || [],
        }
      : null,
    authority: authority
      ? {
          authorityScore: authority?.authorityScore || 0,
          band: authority?.band || null,
          trustSignals: authority?.trustSignals || [],
          confidenceGaps: authority?.confidenceGaps || [],
          blockers: authority?.blockers || [],
        }
      : null,
    schema: schema
      ? {
          completenessScore: schema?.completenessScore || 0,
          qualityScore: schema?.qualityScore || 0,
          band: schema?.band || null,
          missing: schema?.missing || 0,
          broken: schema?.broken || 0,
          templates: schema?.templates || [],
        }
      : null,
    coverage: coverage
      ? {
          contentGaps: coverage?.totals?.contentGaps || 0,
          missingFunnelStages: coverage?.totals?.missingFunnelStages || 0,
          missingIntents: coverage?.totals?.missingIntents || 0,
          riskBand: coverage?.riskBand || null,
          gaps: (coverage?.gaps || []).slice(0, 8),
        }
      : null,
    executiveSummary: executive
      ? {
          insights: executive?.insights || [],
          aiVisibility: executive?.aiVisibility || null,
          signalChips: executive?.signalChips || [],
        }
      : null,
    llmMentions: llm
      ? {
          metrics: llm?.summary?.metrics || null,
          topPages: llm?.summary?.topPages || [],
          topDomains: llm?.summary?.topDomains || [],
          searchExamples: (llm?.summary?.searchExamples || []).slice(0, 3),
          aiVisibility: llm?.aiVisibility || null,
        }
      : null,
  };
}

function buildPrompt(dataSummary) {
  return `You are an expert business analyst specializing in website performance and AI search optimization.

Analyze the following dashboard data and create a comprehensive analytical report with:
1. Executive Summary (2-3 sentences)
2. Key Findings (3-5 bullet points)
3. Strengths (what's working well)
4. Areas for Improvement (what needs attention)
5. Actionable Recommendations (prioritized list)
6. Next Steps (what to do immediately)

Dashboard Data:
${JSON.stringify(dataSummary, null, 2)}

Write the report in clear, non-technical language that business executives can understand. Focus on business impact and actionable insights. Format the response as JSON with the following structure:
{
  "executiveSummary": "string",
  "keyFindings": ["string"],
  "strengths": ["string"],
  "areasForImprovement": ["string"],
  "recommendations": [
    {
      "priority": "high|medium|low",
      "title": "string",
      "description": "string",
      "impact": "string"
    }
  ],
  "nextSteps": ["string"]
}`;
}

function fallbackReport({ dataSummary, reason }) {
  const insights = dataSummary?.executiveSummary?.insights || [];
  const findings = insights
    .map((entry) => entry?.answer || entry?.question)
    .filter(Boolean)
    .slice(0, 5);
  const strengths = [];
  if (Number(dataSummary?.authority?.authorityScore || 0) >= 60) {
    strengths.push(`Authority score is ${dataSummary.authority.authorityScore}/100 (${dataSummary.authority.band || 'Building'}).`);
  }
  if (Number(dataSummary?.schema?.qualityScore || 0) >= 60) {
    strengths.push(`Schema quality score is ${dataSummary.schema.qualityScore}/100 (${dataSummary.schema.band || 'Healthy'}).`);
  }

  const areasForImprovement = (dataSummary?.coverage?.gaps || [])
    .map((gap) => gap?.detail || gap?.label)
    .filter(Boolean)
    .slice(0, 5);

  const recommendations = (dataSummary?.confusion?.recommendedFixes || [])
    .slice(0, 5)
    .map((title) => ({
      priority: 'medium',
      title,
      description: title,
      impact: 'Reduces visitor friction and improves journey clarity.',
    }));

  const nextSteps = reason === 'missing_openai_key'
    ? ['Configure OPENAI_API_KEY (and optionally OPENAI_MODEL/OPENAI_TEMPERATURE) on the gateway environment.']
    : (dataSummary?.coverage?.gaps || [])
        .slice(0, 3)
        .map((gap) => `Address coverage gap: ${gap?.label || gap?.detail || 'Coverage gap'}.`);

  return {
    executiveSummary:
      reason === 'missing_openai_key'
        ? 'OpenAI key is not configured on the gateway, so the narrative report falls back to deterministic dashboard summaries.'
        : 'AI narration is temporarily unavailable; this report falls back to deterministic data summaries from the dashboard bundle.',
    keyFindings: findings.length ? findings : ['No findings available for this range yet.'],
    strengths,
    areasForImprovement,
    recommendations,
    nextSteps,
  };
}

async function callOpenAi({ dataSummary, model, temperature, maxTokens, apiKey }) {
  const prompt = buildPrompt(dataSummary);
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are an expert business analyst. Always respond with valid JSON only, no markdown formatting.' },
        { role: 'user', content: prompt },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI request failed (${response.status})`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI returned no content for AI report');
  }

  let parsed;
  try {
    const cleaned = String(content).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (error) {
    parsed = {
      executiveSummary: String(content),
      keyFindings: [],
      strengths: [],
      areasForImprovement: [],
      recommendations: [],
      nextSteps: [],
    };
  }
  return { report: parsed, tokensUsed: payload?.usage || null };
}

function aiReportEnvelope(row) {
  const serialized = serializeCacheRow(row);
  const freshness = serialized?.metadata || missingFreshness();
  return responseEnvelope({
    key: 'ai_report',
    data: serialized?.payload || null,
    freshness,
    stale: !row || isCacheStale(row),
    generatedAt: freshness.generatedAt,
  });
}

function parseAiReportBody(body) {
  const overrides = body || {};
  const model = overrides.model && typeof overrides.model === 'string' ? overrides.model : DEFAULT_MODEL;
  const temperature = Number.isFinite(Number(overrides.temperature)) ? Number(overrides.temperature) : DEFAULT_TEMPERATURE;
  const maxTokens = Number.isFinite(Number(overrides.maxTokens)) ? Number(overrides.maxTokens) : DEFAULT_MAX_TOKENS;
  const force = overrides.force === true;
  return { model, temperature, maxTokens, force };
}

export async function readDashboardAiReport(request, body = null) {
  const context = parseDashboardContext(request);
  if (!context.siteId) {
    return { status: 400, body: { error: 'siteId is required for AI report generation' } };
  }
  await assertSiteAccess(context);

  const { model, temperature, maxTokens, force } = parseAiReportBody(body);
  const params = {
    portalScope: context.portalScope,
    rangeKey: context.rangeKey,
    model,
    temperature,
    maxTokens,
  };
  const identity = buildCacheIdentity({
    portalScope: context.portalScope,
    moduleKey: 'ai_report',
    siteId: context.siteId,
    rangeKey: context.rangeKey,
    params,
  });

  const forceQuery = request.url.searchParams.get('force') === '1';
  if (!force && !forceQuery) {
    const cached = await getCacheRow(identity);
    if (cached && !isCacheStale(cached)) {
      return ok(aiReportEnvelope(cached));
    }
  }

  const bundleResult = await readDashboardReportBundle(request);
  if (bundleResult?.status && bundleResult.status !== 200) return bundleResult;
  const bundle = bundleResult?.body?.data?.report || {};
  const dataSummary = summarizeBundleForPrompt(bundle, context.rangeKey);
  const apiKey = process.env.OPENAI_API_KEY;

  let report;
  let tokensUsed = null;
  let usedFallback = false;
  let fallbackReason = null;

  if (!apiKey) {
    report = fallbackReport({ dataSummary, reason: 'missing_openai_key' });
    usedFallback = true;
    fallbackReason = 'missing_openai_key';
  } else {
    try {
      const result = await callOpenAi({ dataSummary, model, temperature, maxTokens, apiKey });
      report = result.report;
      tokensUsed = result.tokensUsed;
    } catch (error) {
      console.error('AI report generation failed (using fallback):', error?.message || error);
      report = fallbackReport({ dataSummary, reason: 'openai_request_failed' });
      usedFallback = true;
      fallbackReason = 'openai_request_failed';
    }
  }

  const generatedAt = new Date().toISOString();
  const payload = {
    success: true,
    siteId: context.siteId,
    range: context.rangeKey,
    report,
    narrative: report,
    model,
    temperature,
    maxTokens,
    fallback: usedFallback ? { reason: fallbackReason } : null,
    tokensUsed,
    generatedAt,
  };

  if (!usedFallback) {
    try {
      await upsertCacheRow(identity, payload, { ttlSeconds: ttlForModule('ai_report') });
    } catch (error) {
      console.error('AI report cache write failed (non-fatal):', error?.message || error);
    }
  }

  const freshness = usedFallback
    ? {
        status: 'computed',
        generatedAt,
        sourceWatermarkAt: null,
        expiresAt: null,
        stale: true,
        error: fallbackReason || 'fallback',
      }
    : { ...computedFreshness(), generatedAt };

  return ok(responseEnvelope({
    key: 'ai_report',
    data: payload,
    freshness,
    generatedAt,
    stale: usedFallback,
  }));
}
