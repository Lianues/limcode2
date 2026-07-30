import { describe, expect, it, vi } from 'vitest';

import {
  createGeminiProvider,
  createBootstrapExtensionRegistry,
  createOpenAICompatibleProvider,
  createLLMRouter,
} from '../src/index.js';
import type { LLMRequest } from '../src/index.js';

const request: LLMRequest = {
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  generationConfig: { temperature: 0.2, maxOutputTokens: 64 },
};

describe('provider dryRun', () => {
  it('OpenAI compatible provider: stream/non-stream body 与真实路径一致，且默认 curl 隐藏 Authorization', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body,
      });

      if (body.stream) {
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const provider = createOpenAICompatibleProvider({
      provider: 'openai-compatible',
      model: 'gpt-test',
      apiKey: 'sk-secret',
      baseUrl: 'https://api.openai.test/v1',
      fetch: mockFetch as any,
    });

    const dryStream = await provider.dryRun(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      stream: true,
    });
    expect(mockFetch).not.toHaveBeenCalled();

    for await (const _chunk of provider.chatStream(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
    })) {
      // empty test stream
    }

    expect(calls).toHaveLength(1);
    expect(dryStream.url).toBe(calls[0].url);
    expect(dryStream.headers).toEqual(calls[0].headers);
    expect(dryStream.body).toEqual(calls[0].body);
    expect(dryStream.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(dryStream.headers.Authorization).toBe('Bearer sk-secret');
    expect(dryStream.curl).not.toContain('sk-secret');
    expect(dryStream.curl).toContain('Authorization: ***');

    const dryStreamWithKey = await provider.dryRun(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      stream: true,
      curl: { includeApiKey: true },
    });
    expect(dryStreamWithKey.curl).toContain('Bearer sk-secret');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const dryChat = await provider.dryRun(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      stream: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await provider.chat(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
    });

    expect(calls).toHaveLength(2);
    expect(dryChat.url).toBe(calls[1].url);
    expect(dryChat.headers).toEqual(calls[1].headers);
    expect(dryChat.body).toEqual(calls[1].body);
    expect((dryChat.body as any).stream).toBeUndefined();
  });

  it('Gemini provider: stream=true 使用 stream endpoint，body 与真实 stream encode 一致', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const provider = createGeminiProvider({
      provider: 'gemini',
      model: 'gemini-test',
      apiKey: 'gemini-secret',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      fetch: mockFetch as any,
    });

    const dry = await provider.dryRun(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      stream: true,
    });

    expect(dry.stream).toBe(true);
    expect(dry.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
    expect(mockFetch).not.toHaveBeenCalled();

    for await (const _chunk of provider.chatStream(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
    })) {
      // empty test stream
    }

    expect(calls).toHaveLength(1);
    expect(dry.url).toBe(calls[0].url);
    expect(dry.body).toEqual(calls[0].body);
  });

  it('dryRun 不调用 fetch', async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error('dryRun should not call fetch');
    });

    const provider = createOpenAICompatibleProvider({
      provider: 'openai-compatible',
      model: 'gpt-test',
      apiKey: 'sk-secret',
      baseUrl: 'https://api.openai.test/v1',
      fetch: mockFetch as any,
    });

    const dry = await provider.dryRun(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      stream: false,
    });

    expect(dry.method).toBe('POST');
    expect(dry.url).toBe('https://api.openai.test/v1/chat/completions');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('LLMRouter 支持 dryRun 并委托给目标 provider', async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error('router dryRun should not call fetch');
    });
    const registry = createBootstrapExtensionRegistry();
    const router = createLLMRouter({
      defaultModelName: 'main',
      models: [{
        modelName: 'main',
        provider: 'openai-compatible',
        model: 'gpt-test',
        apiKey: 'sk-secret',
        baseUrl: 'https://api.openai.test/v1',
        fetch: mockFetch as any,
      }],
    }, undefined, registry.llmProviders);

    const dry = await router.dryRun(request, 'main', {
      inputFormat: 'unified',
      outputFormat: 'unified',
      stream: false,
    });

    expect(dry.providerName).toBe('OpenAICompatible');
    expect(dry.stream).toBe(false);
    expect(dry.body).toMatchObject({ model: 'gpt-test' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
