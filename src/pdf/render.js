import React from 'react';
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer';
import { formatDateTime, formatNumber, formatPercent, formatScore, sentenceCase, shorten } from './format.js';

const colors = {
  ink: '#17201d',
  muted: '#59625c',
  border: '#d9ded4',
  soft: '#f7f8f5',
  brand: '#60713b',
  cream: '#f2f0e4',
  white: '#ffffff',
};

const styles = StyleSheet.create({
  page: {
    padding: 34,
    fontFamily: 'Helvetica',
    fontSize: 10,
    lineHeight: 1.35,
    color: colors.ink,
    backgroundColor: colors.white,
  },
  cover: {
    backgroundColor: colors.soft,
  },
  eyebrow: {
    fontSize: 8,
    color: colors.brand,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    lineHeight: 1.1,
    fontFamily: 'Helvetica-Bold',
    color: colors.ink,
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 12,
    color: colors.muted,
    marginBottom: 18,
  },
  sectionTitle: {
    fontSize: 17,
    fontFamily: 'Helvetica-Bold',
    color: colors.ink,
    marginBottom: 8,
  },
  sectionIntro: {
    color: colors.muted,
    marginBottom: 12,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
    marginBottom: 10,
  },
  tile: {
    width: '33.333%',
    padding: 4,
  },
  tileInner: {
    minHeight: 58,
    borderWidth: 0.7,
    borderColor: colors.border,
    borderRadius: 5,
    padding: 9,
    backgroundColor: colors.white,
  },
  tileLabel: {
    fontSize: 7,
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  tileValue: {
    fontSize: 15,
    fontFamily: 'Helvetica-Bold',
    color: colors.ink,
  },
  tileHelp: {
    fontSize: 8,
    color: colors.muted,
    marginTop: 3,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: colors.border,
    paddingVertical: 5,
  },
  headRow: {
    backgroundColor: colors.soft,
    borderTopWidth: 0.5,
    borderTopColor: colors.border,
  },
  cell: {
    paddingHorizontal: 4,
    fontSize: 8,
  },
  headCell: {
    fontFamily: 'Helvetica-Bold',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  paragraph: {
    marginBottom: 6,
  },
  listItem: {
    marginBottom: 6,
  },
  footer: {
    position: 'absolute',
    bottom: 18,
    left: 34,
    right: 34,
    flexDirection: 'row',
    justifyContent: 'space-between',
    color: colors.muted,
    fontSize: 8,
    borderTopWidth: 0.5,
    borderTopColor: colors.border,
    paddingTop: 6,
  },
});

const e = React.createElement;

function metric(label, value, helper) {
  return e(View, { style: styles.tile, key: label },
    e(View, { style: styles.tileInner },
      e(Text, { style: styles.tileLabel }, label),
      e(Text, { style: styles.tileValue }, value),
      helper ? e(Text, { style: styles.tileHelp }, helper) : null,
    ),
  );
}

function metricGrid(items) {
  return e(View, { style: styles.grid }, items.map((item) => metric(item.label, item.value, item.helper)));
}

function footer() {
  return e(View, { fixed: true, style: styles.footer },
    e(Text, null, 'Prepared by GPTO Suite'),
    e(Text, { render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}` }),
  );
}

function sectionPage(title, intro, children) {
  return e(Page, { size: 'A4', style: styles.page },
    e(Text, { style: styles.eyebrow }, 'GPTO Dashboard Export'),
    e(Text, { style: styles.sectionTitle }, title),
    intro ? e(Text, { style: styles.sectionIntro }, intro) : null,
    children,
    footer(),
  );
}

function table(columns, rows, keyPrefix = 'row') {
  return e(View, { wrap: true },
    e(View, { style: [styles.row, styles.headRow] },
      columns.map((column) => e(Text, {
        key: column.key,
        style: [styles.cell, styles.headCell, { width: column.width }],
      }, column.label)),
    ),
    rows.map((row, index) => e(View, { key: `${keyPrefix}-${index}`, style: styles.row, wrap: false },
      columns.map((column) => e(Text, {
        key: column.key,
        style: [styles.cell, { width: column.width }],
      }, column.render(row, index))),
    )),
  );
}

function list(items) {
  const visible = items.filter(Boolean);
  if (visible.length === 0) return e(Text, { style: styles.sectionIntro }, 'No data available for this period.');
  return e(View, null, visible.map((item, index) => e(Text, { key: index, style: styles.listItem }, `- ${item}`)));
}

function coverPage(payload) {
  const composite = payload.executive?.aiVisibility?.composite ?? payload.llmMentions?.aiVisibility?.composite ?? null;
  const authority = payload.authority?.authorityScore ?? null;
  const readability = payload.aiReadability?.overall?.score ?? null;
  const telemetry = payload.telemetry?.totals || {};
  const metrics = [
    { label: 'Visits', value: formatNumber(telemetry.visits), helper: 'Period total' },
    { label: 'Page views', value: formatNumber(telemetry.pageViews), helper: 'Period total' },
    { label: 'AI visibility', value: formatScore(composite), helper: 'Composite signal' },
    { label: 'Authority', value: formatScore(authority), helper: 'Trust score' },
    { label: 'Readability', value: formatScore(readability), helper: 'AI readability' },
    { label: 'Mode', value: sentenceCase(payload.mode), helper: 'Export profile' },
  ];
  return e(Page, { size: 'A4', style: [styles.page, styles.cover] },
    e(Text, { style: styles.eyebrow }, `${payload.mode === 'technical' ? 'Technical' : 'Client'} PDF`),
    e(Text, { style: styles.title }, payload.site?.brand || payload.site?.domain || 'GPTO Dashboard Report'),
    e(Text, { style: styles.subtitle }, `${payload.range.rangeLabel} - Generated ${formatDateTime(payload.generatedAt)}`),
    metricGrid(metrics),
    e(Text, { style: styles.sectionIntro },
      payload.executive?.aiVisibility?.narrative ||
      'Dashboard export covering AI visibility, first-party telemetry, authority, schema, coverage, and friction signals.',
    ),
    footer(),
  );
}

function executivePage(payload) {
  const insights = payload.executive?.insights || [];
  const composite = payload.executive?.aiVisibility?.composite ?? payload.llmMentions?.aiVisibility?.composite ?? null;
  const buckets = payload.executive?.aiVisibility?.buckets || payload.llmMentions?.aiVisibility?.buckets || {};
  return sectionPage('Executive Summary', 'Headline signals and leadership-ready answers.',
    e(View, null,
      metricGrid([
        { label: 'AI Visibility', value: formatScore(composite), helper: 'Composite score' },
        { label: 'Reach', value: formatScore(buckets.reach), helper: 'AI search demand' },
        { label: 'Citation', value: formatScore(buckets.citation), helper: 'Source coverage' },
      ]),
      list(insights.slice(0, 6).map((item) => `${item.question || 'Question'}: ${item.answer || '-'}`)),
    ),
  );
}

function llmPage(payload) {
  const summary = payload.llmMentions?.summary || {};
  const metrics = summary.metrics || {};
  const topPages = summary.topPages || [];
  const topDomains = summary.topDomains || [];
  return sectionPage('LLM Mentions', 'DataForSEO LLM mention snapshots and AI search demand.',
    e(View, null,
      metricGrid([
        { label: 'Mentions', value: formatNumber(metrics.mentions), helper: 'Tracked mentions' },
        { label: 'AI volume', value: formatNumber(metrics.aiSearchVolume), helper: 'Search demand' },
        { label: 'Share of voice', value: formatPercent(metrics.shareOfVoice, { assumeFraction: true }), helper: 'Competitive share' },
      ]),
      e(Text, { style: styles.sectionIntro }, 'Top AI-cited pages'),
      table([
        { key: 'url', label: 'URL', width: '62%', render: (row) => shorten(row.url, 72) },
        { key: 'mentions', label: 'Mentions', width: '19%', render: (row) => formatNumber(row.mentions) },
        { key: 'volume', label: 'AI volume', width: '19%', render: (row) => formatNumber(row.aiSearchVolume) },
      ], topPages.slice(0, payload.mode === 'technical' ? 10 : 6), 'llm-page'),
      e(Text, { style: [styles.sectionIntro, { marginTop: 12 }] }, 'Top citing domains'),
      table([
        { key: 'domain', label: 'Domain', width: '62%', render: (row) => shorten(row.domain, 72) },
        { key: 'mentions', label: 'Mentions', width: '19%', render: (row) => formatNumber(row.mentions) },
        { key: 'volume', label: 'AI volume', width: '19%', render: (row) => formatNumber(row.aiSearchVolume) },
      ], topDomains.slice(0, payload.mode === 'technical' ? 10 : 6), 'llm-domain'),
    ),
  );
}

function telemetryPage(payload) {
  const telemetry = payload.telemetry || {};
  const totals = telemetry.totals || {};
  const trend = telemetry.trend || {};
  const topPages = telemetry.topPages || [];
  return sectionPage('Telemetry', 'First-party activity and journey signals for the selected period.',
    e(View, null,
      metricGrid([
        { label: 'Visits', value: formatNumber(totals.visits), helper: `Trend ${formatNumber(trend.visits)}` },
        { label: 'Page views', value: formatNumber(totals.pageViews), helper: `Trend ${formatNumber(trend.pageViews)}` },
        { label: 'Searches', value: formatNumber(totals.searches), helper: 'On-site search' },
      ]),
      table([
        { key: 'url', label: 'Top page', width: '75%', render: (row) => shorten(row.url, 92) },
        { key: 'count', label: 'Views', width: '25%', render: (row) => formatNumber(row.count) },
      ], topPages.slice(0, payload.mode === 'technical' ? 12 : 8), 'telemetry-page'),
      list((telemetry.anomalies || []).slice(0, 6).map((item) => item.message)),
    ),
  );
}

function qualityPage(payload) {
  const schema = payload.schema || {};
  const coverage = payload.coverage || {};
  const confusion = payload.confusion || {};
  const authority = payload.authority || {};
  return sectionPage('Quality Signals', 'Authority, schema, coverage, and visitor-friction signals.',
    e(View, null,
      metricGrid([
        { label: 'Authority', value: formatScore(authority.authorityScore), helper: 'Trust score' },
        { label: 'Schema completeness', value: formatScore(schema.completenessScore), helper: 'Structured data' },
        { label: 'Coverage fixes', value: formatNumber(coverage.totals?.priorityFixes), helper: 'Priority work' },
      ]),
      e(Text, { style: styles.sectionIntro }, 'Recommended fixes'),
      list([
        ...(confusion.recommendedFixes || []),
        ...(authority.blockers || []),
        ...(coverage.gaps || []).map((gap) => gap.detail || gap.label),
      ].slice(0, payload.mode === 'technical' ? 12 : 7)),
    ),
  );
}

function technicalPage(payload) {
  const readability = payload.aiReadability || {};
  const competitorRows = payload.llmMentions?.competitors?.summary?.comparison || [];
  const sourceGap = payload.llmMentions?.sourceGap?.pageActions || [];
  return sectionPage('Technical Appendix', 'Methodology-facing data for operators and employees.',
    e(View, null,
      metricGrid([
        { label: 'Readability', value: formatScore(readability.overall?.score), helper: readability.overall?.grade || 'AI profile' },
        { label: 'Competitors', value: formatNumber(competitorRows.length), helper: 'Tracked rows' },
        { label: 'Source gaps', value: formatNumber(sourceGap.length), helper: 'Page actions' },
      ]),
      e(Text, { style: styles.sectionIntro }, 'Competitor comparison'),
      table([
        { key: 'target', label: 'Domain', width: '46%', render: (row) => shorten(row.target, 56) },
        { key: 'mentions', label: 'Mentions', width: '18%', render: (row) => formatNumber(row.mentions) },
        { key: 'volume', label: 'AI volume', width: '18%', render: (row) => formatNumber(row.aiSearchVolume) },
        { key: 'sov', label: 'SoV', width: '18%', render: (row) => formatPercent(row.shareOfVoice, { assumeFraction: true }) },
      ], competitorRows.slice(0, 12), 'competitor'),
      e(Text, { style: [styles.sectionIntro, { marginTop: 12 }] }, 'Source-gap actions'),
      list(sourceGap.slice(0, 12).map((row) => `${sentenceCase(row.action)}: ${row.label || row.prompt || row.url || 'Untitled'}`)),
    ),
  );
}

export async function renderDashboardReport(payload) {
  const pages = [
    coverPage(payload),
    executivePage(payload),
    llmPage(payload),
    telemetryPage(payload),
    qualityPage(payload),
  ];
  if (payload.mode === 'technical') pages.push(technicalPage(payload));

  const instance = pdf(e(Document, {
    title: `${payload.site?.brand || payload.site?.domain || 'GPTO'} dashboard report (${payload.mode})`,
    author: 'GPTO Suite',
    subject: 'Dashboard performance report',
    creator: 'GPTO Insights Gateway',
    producer: 'GPTO Insights Gateway',
  }, pages.map((page, index) => React.cloneElement(page, { key: `page-${index}` }))));
  const stream = await instance.toBuffer();

  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
