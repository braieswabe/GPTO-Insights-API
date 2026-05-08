import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLlmMentionsBundleBody } from '../src/services/llm-mentions.js';

describe('LLM Mentions bundle contract', () => {
  it('exposes top-level data.llmMentions.aiVisibility from the overview payload', () => {
    const body = buildLlmMentionsBundleBody({
      overview: {
        data: {
          combined: {
            aiVisibility: {
              composite: 80,
              band: 'Strong',
              breakdown: {
                reach: { score: 85, band: 'Strong' },
              },
            },
          },
        },
      },
      legacy: {
        aiVisibility: {
          composite: 20,
          band: 'Weak',
        },
      },
      sections: [
        { name: 'overview', ok: true, value: {}, durationMs: 1 },
        { name: 'legacy', ok: true, value: {}, durationMs: 1 },
      ],
    });

    assert.equal(body.data.llmMentions.aiVisibility.composite, 80);
    assert.equal(body.data.llmMentions.aiVisibility.band, 'Strong');
    assert.equal(body.data.llmMentions.aiVisibility.breakdown.reach.score, 85);
  });

  it('falls back to legacy aiVisibility when overview is missing it', () => {
    const body = buildLlmMentionsBundleBody({
      overview: { data: { combined: {} } },
      legacy: {
        aiVisibility: {
          composite: 42,
          band: 'Limited',
        },
      },
      sections: [],
    });

    assert.equal(body.data.llmMentions.aiVisibility.composite, 42);
    assert.equal(body.data.llmMentions.aiVisibility.band, 'Limited');
  });
});
