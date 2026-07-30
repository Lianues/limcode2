import { describe, expect, it } from 'vitest';

import {
  normalizeLLMRequestThoughtSignatures,
  parseThoughtSignature,
  resolveSignatureOutputMode,
  serializeLLMResponseThoughtSignatures,
} from '../src/index.js';
import type { LLMRequest, LLMResponse } from '../src/index.js';

describe('thought signature 归一化与序列化', () => {
  it('带前缀字符串签名会被归一化为对象签名', () => {
    const request: LLMRequest = {
      contents: [{ role: 'model', parts: [{ text: 'thinking', thought: true, thoughtSignature: 'gemini:sig_123' }] }],
    };

    const normalized = normalizeLLMRequestThoughtSignatures(request);
    const part = normalized.contents[0].parts[0] as any;
    expect(part.thoughtSignature).toBeUndefined();
    expect(part.thoughtSignatures).toEqual({ gemini: 'sig_123' });
  });

  it('无前缀字符串签名 + formatHint 会按 hint 归类', () => {
    const request: LLMRequest = {
      contents: [{ role: 'model', parts: [{ text: 'thinking', thought: true, thoughtSignature: 'sig_abc' }] }],
    };

    const normalized = normalizeLLMRequestThoughtSignatures(request, { formatHint: 'claude' });
    const part = normalized.contents[0].parts[0] as any;
    expect(part.thoughtSignatures).toEqual({ claude: 'sig_abc' });
  });

  it('无前缀字符串签名 + 无 hint 时保持原样，不强行转换', () => {
    const request: LLMRequest = {
      contents: [{ role: 'model', parts: [{ text: 'thinking', thought: true, thoughtSignature: 'sig_raw' }] }],
    };

    const normalized = normalizeLLMRequestThoughtSignatures(request);
    const part = normalized.contents[0].parts[0] as any;
    expect(part.thoughtSignature).toBe('sig_raw');
    expect(part.thoughtSignatures).toBeUndefined();
  });

  it('显式指定格式时，auto 输出模式默认为 string', () => {
    const request: LLMRequest = {
      contents: [{ role: 'model', parts: [{ text: 'thinking', thought: true, thoughtSignature: 'sig_raw' }] }],
    };

    expect(resolveSignatureOutputMode(request, { formatSpecified: true })).toBe('string');
  });

  it('未指定格式时，根据输入签名表示法推断输出模式', () => {
    const withObject: LLMRequest = {
      contents: [{ role: 'model', parts: [{ text: 'thinking', thought: true, thoughtSignatures: { claude: 'sig_obj' } }] }],
    };
    const withoutSignature: LLMRequest = {
      contents: [{ role: 'model', parts: [{ text: 'thinking', thought: true }] }],
    };

    expect(resolveSignatureOutputMode(withObject)).toBe('object');
    expect(resolveSignatureOutputMode(withoutSignature)).toBe('preserve');
  });

  it('对象签名可序列化为自动带前缀的字符串签名', () => {
    const response: LLMResponse = {
      content: {
        role: 'model',
        parts: [{ text: 'deep thought', thought: true, thoughtSignatures: { claude: 'sig_resp_1' } }],
      },
    };

    const serialized = serializeLLMResponseThoughtSignatures(response, { mode: 'string' });
    const part = serialized.content.parts[0] as any;
    expect(part.thoughtSignature).toBe('claude:sig_resp_1');
    expect(part.thoughtSignatures).toBeUndefined();
  });

  it('parseThoughtSignature 只接受明确的 OpenAI 系前缀', () => {
    expect(parseThoughtSignature('openai-responses:enc_001')).toEqual({ provider: 'openai-responses', value: 'enc_001', hadPrefix: true });
    expect(parseThoughtSignature('openai-compatible:enc_002')).toEqual({ provider: 'openai-compatible', value: 'enc_002', hadPrefix: true });
    expect(() => parseThoughtSignature('openai:enc_003')).toThrow('不再支持 openai 签名前缀');
  });
});
