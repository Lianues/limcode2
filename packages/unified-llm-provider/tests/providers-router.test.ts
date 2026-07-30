import { describe, expect, it, vi } from 'vitest';

import {
  createBootstrapExtensionRegistry,
  createClaudeProvider,
  createGeminiProvider,
  createLLMRouter,
} from '../src/index.js';
import type { LLMRequest } from '../src/index.js';

describe('providers / router', () => {
  it('Claude provider 支持自定义 url / headers / requestBody / fetch，且可把 Claude 响应自动转回 unified', async () => {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({
        content: [
          { type: 'thinking', thinking: 'deep thought', signature: 'sig_claude_resp' },
          { type: 'text', text: 'done' },
        ],
        stop_reason: 'end_turn',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const provider = createClaudeProvider({
      provider: 'claude',
      model: 'claude-sonnet-4',
      apiKey: 'test-key',
      baseUrl: 'https://api.anthropic.com/v1',
      endpoint: {
        url: 'https://example.com/custom/messages',
        headers: { 'x-endpoint-header': 'endpoint' },
      },
      headers: { 'x-top-header': 'top' },
      requestBody: { metadata: { source: 'unit-test' } },
      fetch: mockFetch as any,
    });

    const request: LLMRequest = {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { maxOutputTokens: 256 },
    };

    const response = await provider.chat(request, { inputFormat: 'unified', outputFormat: 'unified' }) as any;
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/custom/messages');
    expect(calls[0].headers['x-api-key']).toBe('test-key');
    expect(calls[0].headers['x-top-header']).toBe('top');
    expect(calls[0].headers['x-endpoint-header']).toBe('endpoint');
    expect(calls[0].body.metadata.source).toBe('unit-test');

    const thought = response.content.parts[0] as any;
    expect(thought.thoughtSignature).toBe('claude:sig_claude_resp');
    expect(thought.thoughtSignatures).toBeUndefined();
  });

  it('Provider 支持通过调用参数 proxy 显式指定 HTTP 代理', async () => {
    const calls: Array<{ dispatcher: unknown; body: any }> = [];
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit & { dispatcher?: unknown }) => {
      calls.push({
        dispatcher: init?.dispatcher,
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const provider = createClaudeProvider({
      provider: 'claude',
      model: 'claude-sonnet-4',
      apiKey: 'test-key',
      baseUrl: 'https://api.anthropic.com/v1',
      fetch: mockFetch as any,
    });

    await provider.chat({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    }, { inputFormat: 'unified', outputFormat: 'unified', proxy: 'http://127.0.0.1:7890' });

    expect(calls).toHaveLength(1);
    expect(calls[0].dispatcher).toBeTruthy();
    expect(calls[0].body.messages[0].content).toBe('hello');
  });

  it('当用户传入 Claude 格式并实际调用 Gemini 时：请求不错误复用 Claude 签名，返回仍按 Claude 格式但签名前缀为 gemini', async () => {
    const calls: any[] = [];
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { text: 'gemini thought', thought: true, thoughtSignature: 'sig_gem_resp' },
              { text: 'gemini done' },
            ],
          },
          finishReason: 'STOP',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const provider = createGeminiProvider({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      fetch: mockFetch as any,
    });

    const claudeLikeInput = {
      system: 'You are helpful',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'legacy claude thought', signature: 'sig_claude_only' },
            { type: 'text', text: 'legacy answer' },
          ],
        },
      ],
    };

    const response = await provider.chat(claudeLikeInput, {
      inputFormat: 'claude',
      // 不显式传 outputFormat，默认回到 from 格式 claude
    }) as any;

    expect(calls).toHaveLength(1);
    const sentThoughtPart = calls[0].contents[1].parts[0];
    expect(sentThoughtPart.thought).toBe(true);
    expect(sentThoughtPart.thoughtSignature).toBeUndefined();

    expect(response.content[0].type).toBe('thinking');
    expect(response.content[0].signature).toBe('gemini:sig_gem_resp');
    expect(response.content[0].thinking).toBe('gemini thought');
    expect(response.content[1].text).toBe('gemini done');
  });

  it('Claude provider 可接收其他格式输入并按指定格式输出', async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({
      content: [
        { type: 'thinking', thinking: 'deep thought', signature: 'sig_claude_resp' },
        { type: 'text', text: 'done' },
      ],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const provider = createClaudeProvider({
      provider: 'claude',
      model: 'claude-sonnet-4',
      apiKey: 'test-key',
      baseUrl: 'https://api.anthropic.com/v1',
      fetch: mockFetch as any,
    });

    const openAICompatibleRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'hello' },
      ],
    };

    const response = await provider.chat(openAICompatibleRequest, {
      inputFormat: 'openai-compatible',
      outputFormat: 'claude',
    }) as any;

    expect(response.content[0].type).toBe('thinking');
    expect(response.content[0].signature).toBe('claude:sig_claude_resp');
    expect(response.content[1].text).toBe('done');
  });

  it('factory + router 可创建并切换多个模型', () => {
    const registry = createBootstrapExtensionRegistry();
    const router = createLLMRouter({
      defaultModelName: 'main',
      models: [
        {
          modelName: 'main',
          provider: 'gemini',
          model: 'gemini-2.0-flash',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          apiKey: 'k1',
        },
        {
          modelName: 'backup',
          provider: 'claude',
          model: 'claude-sonnet-4',
          baseUrl: 'https://api.anthropic.com/v1',
          apiKey: 'k2',
        },
      ],
    }, undefined, registry.llmProviders);

    expect(router.getCurrentModelInfo().modelName).toBe('main');
    expect(router.listModels()).toHaveLength(2);
    router.setCurrentModel('backup');
    expect(router.getCurrentModelInfo().provider).toBe('claude');
    expect(router.name).toBe('backup');
  });
});
