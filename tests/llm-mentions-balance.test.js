import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectBalancedSearchObservations } from '../src/builders/llm-mentions.js';

describe('LLM Mentions search example selection', () => {
  it('keeps both DataForSEO platforms visible when one source has newer rows', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) => ({ id: `google-${index}`, source: 'google_ai_overviews' })),
      ...Array.from({ length: 8 }, (_, index) => ({ id: `chat-${index}`, source: 'chat_gpt' })),
    ];
    const selected = selectBalancedSearchObservations(
      rows,
      ['chat_gpt', 'google_ai_overviews', 'gemini', 'claude'],
      6
    );

    assert.equal(selected.length, 6);
    assert.deepEqual(selected.map((row) => row.source), [
      'chat_gpt',
      'google_ai_overviews',
      'chat_gpt',
      'google_ai_overviews',
      'chat_gpt',
      'google_ai_overviews',
    ]);
  });
});
