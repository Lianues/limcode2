import { describe, expect, it } from 'vitest';

import {
  ClaudeFormat,
  GeminiFormat,
  OpenAIResponsesFormat,
  decodeResponseFromFormat,
} from '../src/index.js';
import type { LLMRequest } from '../src/index.js';

describe('format adapters', () => {
  it('GeminiFormat: thoughtSignatures.gemini -> thoughtSignature', () => {
    const fmt = new GeminiFormat();
    const request: LLMRequest = {
      contents: [{
        role: 'model',
        parts: [{ text: 'thinking', thought: true, thoughtSignatures: { gemini: 'sig_gem_1' } }],
      }],
    };

    const body = fmt.encodeRequest(request) as any;
    expect(body.contents[0].parts[0].thoughtSignature).toBe('sig_gem_1');
    expect(body.contents[0].parts[0].thoughtSignatures).toBeUndefined();
  });

  it('GeminiFormat: 发送 inlineData 时会剥离本地文件名', () => {
    const fmt = new GeminiFormat();
    const request: LLMRequest = {
      contents: [{
        role: 'user',
        parts: [{ inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=', name: 'paper.pdf' } }],
      }],
    };

    const body = fmt.encodeRequest(request) as any;
    expect(body.contents[0].parts[0].inlineData).toEqual({
      mimeType: 'application/pdf',
      data: 'JVBERi0=',
    });
  });


  it('ClaudeFormat: thinking block 的 signature 字段正确传递', () => {
    const fmt = new ClaudeFormat('claude-sonnet-4');
    const request: LLMRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'deep thought', thought: true, thoughtSignatures: { claude: 'sig_claude_1' } }] },
      ],
    };

    const body = fmt.encodeRequest(request) as any;
    const thinking = body.messages[1].content.find((block: any) => block.type === 'thinking');
    expect(thinking.signature).toBe('sig_claude_1');
    expect(thinking.thinking).toBe('deep thought');
  });

  it('ClaudeFormat: 无签名 thought part 也会转成 thinking block', () => {
    const fmt = new ClaudeFormat('claude-sonnet-4');
    const request: LLMRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'reasoning without signature', thought: true }, { text: 'answer' }] },
      ],
    };

    const body = fmt.encodeRequest(request) as any;
    const thinking = body.messages[1].content.find((block: any) => block.type === 'thinking');
    expect(thinking.thinking).toBe('reasoning without signature');
    expect(thinking.signature).toBeUndefined();
  });

  it('OpenAIResponsesFormat: reasoning item 会回传 encrypted_content', () => {
    const fmt = new OpenAIResponsesFormat('o3');
    const request: LLMRequest = {
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'deep thought', thought: true, thoughtSignatures: { 'openai-responses': 'enc_sig_1' } }] },
      ],
    };

    const body = fmt.encodeRequest(request) as any;
    const reasoning = body.input.find((item: any) => item.type === 'reasoning');
    expect(reasoning.encrypted_content).toBe('enc_sig_1');
  });

  it('decodeResponseFromFormat 默认返回自动拼接前缀的字符串签名', () => {
    const response = decodeResponseFromFormat({
      content: [
        { type: 'thinking', thinking: 'let me think', signature: 'sig_dec_1' },
        { type: 'text', text: 'done' },
      ],
      stop_reason: 'end_turn',
    }, { format: 'claude', model: 'claude-sonnet-4' });

    const thought = response.content.parts[0] as any;
    expect(thought.thoughtSignature).toBe('claude:sig_dec_1');
    expect(thought.thoughtSignatures).toBeUndefined();
  });

  it('Gemini usageMetadata 解码到 unified 时会过滤模态/tier/tool 等非通用字段', () => {
    const response = decodeResponseFromFormat({
      candidates: [{
        content: { role: 'model', parts: [{ text: 'done' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 10,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 3,
        totalTokenCount: 18,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 10 }],
        cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 2 }],
        candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 5 }],
        toolUsePromptTokenCount: 7,
        toolUsePromptTokensDetails: [{ modality: 'TEXT', tokenCount: 7 }],
        serviceTier: 'STANDARD',
      },
    }, { format: 'gemini' }) as any;

    expect(response.usageMetadata).toEqual({
      promptTokenCount: 10,
      cachedContentTokenCount: 2,
      candidatesTokenCount: 5,
      thoughtsTokenCount: 3,
      totalTokenCount: 18,
    });
  });
});
