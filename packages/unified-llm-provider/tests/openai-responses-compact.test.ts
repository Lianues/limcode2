import { describe, expect, it, vi } from 'vitest';

import {
  createOpenAIResponsesProvider,
  isProviderContextPart,
} from '../src/index.js';
import type { LLMRequest } from '../src/index.js';

const request: LLMRequest = {
  systemInstruction: { parts: [{ text: 'You are helpful.' }] },
  contents: [{ role: 'user', parts: [{ text: 'Create a landing page.' }] }],
  generationConfig: {
    maxOutputTokens: 123,
    temperature: 0.7,
    thinkingConfig: { thinkingLevel: 'high' },
  },
};

describe('OpenAI Responses compact', () => {
  it('compactDryRun 构建无状态 /responses/compact 请求，且不携带普通生成字段', async () => {
    const provider = createOpenAIResponsesProvider({
      provider: 'openai-responses',
      model: 'gpt-5.4',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
    });

    const dry = await provider.compactDryRun(request, {
      requestBody: { service_tier: 'priority' },
    });

    expect(dry.url).toBe('https://api.openai.test/v1/responses/compact');
    expect(dry.stream).toBe(false);
    expect(dry.body).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'You are helpful.',
      service_tier: 'priority',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Create a landing page.' }] }],
    });
    expect((dry.body as any).store).toBeUndefined();
    expect((dry.body as any).include).toBeUndefined();
    expect((dry.body as any).stream).toBeUndefined();
    expect((dry.body as any).reasoning).toBeUndefined();
    expect((dry.body as any).max_output_tokens).toBeUndefined();
    expect((dry.body as any).temperature).toBeUndefined();
    expect((dry.body as any).previous_response_id).toBeUndefined();
  });

  it('compact 返回 unified compact response，并把 compaction item 存为 providerContext part', async () => {
    const rawCompactResponse = {
      id: 'resp_001',
      object: 'response.compaction',
      created_at: 1764967971,
      output: [
        {
          id: 'msg_000',
          type: 'message',
          status: 'completed',
          content: [{ type: 'input_text', text: 'Create a landing page.' }],
          role: 'user',
        },
        {
          id: 'cmp_001',
          type: 'compaction',
          encrypted_content: 'gAAAAABpM0Yj-test',
        },
      ],
      usage: {
        input_tokens: 139,
        input_tokens_details: { cached_tokens: 7 },
        output_tokens: 438,
        output_tokens_details: { reasoning_tokens: 64 },
        total_tokens: 577,
      },
    };

    const mockFetch = vi.fn(async () => new Response(JSON.stringify(rawCompactResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const provider = createOpenAIResponsesProvider({
      provider: 'openai-responses',
      model: 'gpt-5.4',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      fetch: mockFetch as any,
    });

    const compacted = await provider.compact(request) as any;

    expect(compacted.object).toBe('response.compaction');
    expect(compacted.id).toBe('resp_001');
    expect(compacted.createdAt).toBe(1764967971);
    expect(compacted.usageMetadata).toEqual({
      promptTokenCount: 139,
      cachedContentTokenCount: 7,
      candidatesTokenCount: 438,
      thoughtsTokenCount: 64,
      totalTokenCount: 577,
    });

    expect(compacted.contents).toHaveLength(2);
    expect(compacted.contents[0].role).toBe('user');
    expect(compacted.contents[0].parts[0].text).toBe('Create a landing page.');
    expect(compacted.contents[0].providerContext.rawItem.id).toBe('msg_000');

    const compactionPart = compacted.contents[1].parts[0];
    expect(isProviderContextPart(compactionPart)).toBe(true);
    expect(compactionPart.providerContext).toMatchObject({
      provider: 'openai',
      format: 'openai-responses',
      endpoint: 'responses.compact',
      itemType: 'compaction',
      id: 'cmp_001',
      encryptedContent: 'gAAAAABpM0Yj-test',
    });
  });

  it('compact 后的 unified contents 可继续通过 provider.chat 回放 compaction raw item', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(input), body });

      if (String(input).endsWith('/responses/compact')) {
        return new Response(JSON.stringify({
          id: 'resp_001',
          object: 'response.compaction',
          created_at: 1764967971,
          output: [
            { id: 'msg_000', type: 'message', status: 'completed', content: [{ type: 'input_text', text: 'old user' }], role: 'user' },
            { id: 'cmp_001', type: 'compaction', encrypted_content: 'encrypted-compact-state' },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const provider = createOpenAIResponsesProvider({
      provider: 'openai-responses',
      model: 'gpt-5.4',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      fetch: mockFetch as any,
    });

    const compacted = await provider.compact({ contents: [{ role: 'user', parts: [{ text: 'old user' }] }] }) as any;
    await provider.chat({
      contents: [
        ...compacted.contents,
        { role: 'user', parts: [{ text: 'next user' }] },
      ],
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://api.openai.test/v1/responses');
    expect(calls[1].body.input).toEqual([
      { id: 'msg_000', type: 'message', status: 'completed', content: [{ type: 'input_text', text: 'old user' }], role: 'user' },
      { id: 'cmp_001', type: 'compaction', encrypted_content: 'encrypted-compact-state' },
      { role: 'user', content: [{ type: 'input_text', text: 'next user' }] },
    ]);
  });

  it('outputFormat=openai-responses 时返回原生 compact response', async () => {
    const rawCompactResponse = {
      id: 'resp_raw',
      object: 'response.compaction',
      created_at: 1,
      output: [{ id: 'cmp_raw', type: 'compaction', encrypted_content: 'raw' }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const provider = createOpenAIResponsesProvider({
      provider: 'openai-responses',
      model: 'gpt-5.4',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      fetch: vi.fn(async () => new Response(JSON.stringify(rawCompactResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as any,
    });

    const raw = await provider.compact({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }, {
      outputFormat: 'openai-responses',
    }) as any;

    expect(raw).toEqual(rawCompactResponse);
  });

  it('compact 会跟随调用方 signal 中止未 settle 的 fetch', async () => {
    const mockFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const provider = createOpenAIResponsesProvider({
      provider: 'openai-responses',
      model: 'gpt-5.4',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      fetch: mockFetch as any,
    });

    await expect(provider.compact(request, { signal: AbortSignal.timeout(10) })).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
