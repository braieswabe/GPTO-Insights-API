import { rangeLabel } from './format.js';

function asRecord(value) {
  return value && typeof value === 'object' ? value : null;
}

function isErrorRecord(value) {
  const record = asRecord(value);
  return Boolean(record && 'error' in record);
}

function pickRecord(value) {
  if (!value || typeof value !== 'object') return null;
  if (isErrorRecord(value)) return null;
  return value;
}

export function composeReportPayload({
  bundle,
  rangeKey,
  start,
  end,
  siteId = null,
  mode = 'client',
  preparedFor = null,
}) {
  const safeBundle = bundle || {};
  const telemetry = pickRecord(safeBundle.telemetry);
  const confusion = pickRecord(safeBundle.confusion);
  const authority = pickRecord(safeBundle.authority);
  const schema = pickRecord(safeBundle.schema);
  const coverage = pickRecord(safeBundle.coverage);
  const executiveSummary = pickRecord(safeBundle.executiveSummary || safeBundle.executive);
  const aiReadability = pickRecord(safeBundle.aiReadability);
  const llmMentionsRaw = pickRecord(safeBundle.llmMentions);
  const llmMentionsSourceGap = pickRecord(safeBundle.llmMentionsSourceGap);
  const llmMentionsCompetitors = pickRecord(safeBundle.llmMentionsCompetitors);

  const siteDetail = asRecord(safeBundle.siteDetail);
  const siteRecord = asRecord(siteDetail?.site);
  const configRecord = asRecord(siteDetail?.config);
  const blackboxRecord = asRecord(configRecord?.panthera_blackbox);
  const blackboxSiteRecord = asRecord(blackboxRecord?.site);
  const domain =
    siteRecord?.domain ||
    llmMentionsRaw?.siteDomain ||
    null;
  const brand =
    blackboxSiteRecord?.brand ||
    siteRecord?.name ||
    domain ||
    null;

  const llmMentions = llmMentionsRaw
    ? {
        summary: llmMentionsRaw.summary || null,
        aiVisibility: llmMentionsRaw.aiVisibility || executiveSummary?.aiVisibility || null,
        sourceGap: llmMentionsSourceGap,
        competitors: llmMentionsCompetitors,
        siteDomain: llmMentionsRaw.siteDomain || domain || null,
      }
    : executiveSummary?.aiVisibility
      ? { aiVisibility: executiveSummary.aiVisibility, siteDomain: domain || null }
      : null;

  return {
    generatedAt: new Date().toISOString(),
    range: {
      rangeKey,
      rangeLabel: rangeLabel(rangeKey, start, end),
      start: rangeKey === 'custom' ? start.toISOString() : null,
      end: rangeKey === 'custom' ? end.toISOString() : null,
    },
    site: {
      id: siteId || null,
      domain,
      brand,
      preparedFor: preparedFor || null,
    },
    preparedFor: preparedFor || brand || null,
    mode,
    telemetry: telemetry || null,
    confusion: confusion || null,
    authority: authority || null,
    schema: schema || null,
    coverage: coverage || null,
    executive: executiveSummary
      ? {
          insights: executiveSummary.insights || [],
          aiVisibility: executiveSummary.aiVisibility || null,
        }
      : null,
    aiReadability: aiReadability || null,
    llmMentions,
  };
}
