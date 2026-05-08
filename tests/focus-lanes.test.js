import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFocusLanes } from '../src/builders/executive-summary.js';

describe('buildFocusLanes — server-built focus lanes', () => {
  it('returns three lanes with stable ids and labels', () => {
    const lanes = buildFocusLanes({});
    assert.equal(typeof lanes, 'object');
    assert.equal(lanes.performingWell.id, 'performing_well');
    assert.equal(lanes.needsAttention.id, 'needs_attention');
    assert.equal(lanes.opportunities.id, 'opportunities');
    assert.equal(lanes.performingWell.label, 'Performing Well');
    assert.equal(lanes.needsAttention.label, 'Needs Attention');
    assert.equal(lanes.opportunities.label, 'Not Effective');
  });

  it('returns empty items when nothing is supplied', () => {
    const lanes = buildFocusLanes({});
    assert.deepEqual(lanes.performingWell.items, []);
    assert.deepEqual(lanes.needsAttention.items, []);
    assert.deepEqual(lanes.opportunities.items, []);
  });

  it('builds Performing Well from telemetry.topPages (works without selected site)', () => {
    const lanes = buildFocusLanes({
      telemetry: {
        topPages: [
          { url: 'https://example.com/a', count: 100 },
          { url: 'https://example.com/b', count: 50 },
        ],
      },
    });
    assert.equal(lanes.performingWell.items.length, 2);
    assert.equal(lanes.performingWell.items[0].label, 'https://example.com/a');
    assert.equal(lanes.performingWell.items[0].severity, 'good');
    assert.equal(lanes.performingWell.items[0].source, 'telemetry.topPages');
    assert.equal(lanes.performingWell.items[0].href, 'https://example.com/a');
    assert.match(lanes.performingWell.items[0].value, /100/);
  });

  it('augments Performing Well with AI-cited pages from llmMentions', () => {
    const lanes = buildFocusLanes({
      telemetry: { topPages: [{ url: 'https://x.com/', count: 10 }] },
      llmMentions: { summary: { topPages: [{ url: 'docs.x.com/faq', count: 4 }] } },
    });
    assert.equal(lanes.performingWell.items.length, 2);
    const aiCited = lanes.performingWell.items.find((it) => it.source === 'llmMentions.topPages');
    assert.ok(aiCited, 'expected an AI-cited entry');
    assert.match(aiCited.label, /AI-cited/);
    assert.equal(aiCited.href, 'https://docs.x.com/faq');
  });

  it('Needs Attention includes critical AND warn (drops info/ok) AI signals', () => {
    const lanes = buildFocusLanes({
      aiVisibility: {
        signals: [
          { id: 'crit', level: 'critical', message: 'Major gap' },
          { id: 'wn', level: 'warn', message: 'Watchout' },
          { id: 'info', level: 'info', message: 'FYI' },
          { id: 'ok', level: 'ok', message: 'Healthy' },
        ],
      },
    });
    const labels = lanes.needsAttention.items.map((it) => it.label);
    assert.ok(labels.includes('Major gap'));
    assert.ok(labels.includes('Watchout'));
    assert.ok(!labels.includes('FYI'));
    assert.ok(!labels.includes('Healthy'));
    const crit = lanes.needsAttention.items.find((it) => it.label === 'Major gap');
    assert.equal(crit.severity, 'critical');
    const wn = lanes.needsAttention.items.find((it) => it.label === 'Watchout');
    assert.equal(wn.severity, 'warn');
  });

  it('Needs Attention blends coverage priority items + confusion dead-ends', () => {
    const lanes = buildFocusLanes({
      coverage: {
        priorityItems: [{ id: 'gap-1', label: 'Missing pricing FAQ', severity: 'critical', pages: ['/pricing'] }],
      },
      confusion: {
        signals: { deadEnds: [{ url: '/checkout', count: 12 }] },
      },
    });
    assert.equal(lanes.needsAttention.items.length, 2);
    const cov = lanes.needsAttention.items.find((it) => it.source === 'coverage.priorityItems');
    assert.equal(cov.severity, 'critical');
    assert.equal(cov.href, 'https://pricing'); // ensureUrl normalizes /pricing to https://pricing
    const dead = lanes.needsAttention.items.find((it) => it.source === 'confusion.deadEnds');
    assert.match(dead.label, /Dead end/);
  });

  it('Opportunities lane reads confusion.repeatedSearches', () => {
    const lanes = buildFocusLanes({
      confusion: {
        signals: { repeatedSearches: [{ query: 'pricing', count: 22 }, { query: 'demo', count: 5 }] },
      },
    });
    assert.equal(lanes.opportunities.items.length, 2);
    assert.match(lanes.opportunities.items[0].label, /pricing/);
    assert.equal(lanes.opportunities.items[0].severity, 'watch');
    assert.match(lanes.opportunities.items[0].value, /22/);
  });

  it('caps lane sizes (no unbounded growth)', () => {
    const big = Array.from({ length: 20 }, (_, i) => ({ url: `https://x.com/${i}`, count: i }));
    const lanes = buildFocusLanes({
      telemetry: { topPages: big },
      confusion: { signals: { repeatedSearches: big.map((b) => ({ query: String(b.count), count: b.count })) } },
    });
    assert.ok(lanes.performingWell.items.length <= 5, 'performingWell should cap at 5 (3 telemetry + 2 ai-cited)');
    assert.equal(lanes.opportunities.items.length, 3);
  });

  it('deduplicates Performing Well by URL', () => {
    const lanes = buildFocusLanes({
      telemetry: { topPages: [{ url: 'https://x.com/', count: 1 }, { url: 'https://x.com/', count: 2 }] },
    });
    assert.equal(lanes.performingWell.items.length, 1);
  });
});
