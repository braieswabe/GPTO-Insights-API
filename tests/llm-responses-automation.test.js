import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LLM_RESPONSES_MODELS,
  LLM_RESPONSES_PLATFORMS,
  isLlmResponsesPlatform,
} from '../src/services/llm-responses-automation.js';

describe('LLM Responses automation', () => {
  it('covers the four live DataForSEO platforms with cost-efficient default models', () => {
    assert.deepEqual(LLM_RESPONSES_PLATFORMS, ['chat_gpt', 'claude', 'gemini', 'perplexity']);
    assert.equal(DEFAULT_LLM_RESPONSES_MODELS.chat_gpt, 'gpt-4.1-mini');
    assert.equal(DEFAULT_LLM_RESPONSES_MODELS.claude, 'claude-haiku-4-5');
    assert.equal(DEFAULT_LLM_RESPONSES_MODELS.gemini, 'gemini-2.5-flash-lite');
    assert.equal(DEFAULT_LLM_RESPONSES_MODELS.perplexity, 'sonar');
  });

  it('rejects unknown platforms', () => {
    assert.equal(isLlmResponsesPlatform('chat_gpt'), true);
    assert.equal(isLlmResponsesPlatform('bing'), false);
  });
});
