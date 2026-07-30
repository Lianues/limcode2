import { describe, expect, it, vi } from 'vitest';

import { listAvailableModels } from '../src/index.js';

describe('model catalog', () => {
  it('deepseek 在无 apiKey 时返回内置模型列表', async () => {
    const fetchMock = vi.fn();
    const result = await listAvailableModels({
      provider: 'deepseek',
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/v1',
      fetch: fetchMock as any,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.models.map(model => model.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
  });

  it('openai-compatible 会请求 /v1/models 并带 limit 参数解析列表', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        data: [
          { id: 'gpt-4o', object: 'model', created: 1720000000, owned_by: 'openai' },
          { id: 'gpt-4.1', owned_by: 'openai' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listAvailableModels({
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      fetch: fetchMock as any,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urls[0]).toBe('https://api.openai.com/v1/models?limit=1000');
    expect(result.models.map(model => model.id)).toEqual(['gpt-4o', 'gpt-4.1']);
    expect(result.models[0]).toMatchObject({
      id: 'gpt-4o',
      name: 'gpt-4o',
      displayName: 'gpt-4o',
      modelType: 'model',
      ownedBy: 'openai',
      created: 1720000000,
      createdAt: new Date(1720000000 * 1000).toISOString(),
    });
  });

  it('openai-compatible 会根据 has_more/last_id 继续分页，直到拿完整列表', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return new Response(JSON.stringify({
          object: 'list',
          data: [{ id: 'model-a', object: 'model', owned_by: 'vendor' }],
          has_more: true,
          last_id: 'model-a',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'model-b', object: 'model', owned_by: 'vendor' }],
        has_more: false,
        last_id: 'model-b',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listAvailableModels({
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      outputFormat: 'openai-compatible',
      fetch: fetchMock as any,
    });

    expect(urls).toEqual([
      'https://api.openai.com/v1/models?limit=1000',
      'https://api.openai.com/v1/models?limit=1000&after=model-a',
    ]);
    expect(result).toEqual({
      object: 'list',
      data: [
        { id: 'model-a', object: 'model', owned_by: 'vendor' },
        { id: 'model-b', object: 'model', owned_by: 'vendor' },
      ],
    });
  });

  it('gemini 使用 v1beta/models?key=xx 分页，并可转换为 OpenAI 模型列表格式', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return new Response(JSON.stringify({
          models: [
            {
              name: 'models/gemini-1.5-flash-001',
              baseModelId: 'gemini-1.5-flash',
              displayName: 'Gemini 1.5 Flash',
              inputTokenLimit: 1048576,
              outputTokenLimit: 8192,
              supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
            },
          ],
          nextPageToken: 'next-token',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        models: [
          { name: 'models/embedding-001' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listAvailableModels({
      provider: 'gemini',
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      outputFormat: 'openai-compatible',
      fetch: fetchMock as any,
    });

    expect(urls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key&pageSize=1000',
      'https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key&pageSize=1000&pageToken=next-token',
    ]);
    expect(result.object).toBe('list');
    expect(result.data.map(model => model.id)).toEqual(['gemini-1.5-flash', 'embedding-001']);
    expect(result.data[0]).toMatchObject({
      id: 'gemini-1.5-flash',
      name: 'models/gemini-1.5-flash-001',
      baseModelId: 'gemini-1.5-flash',
      displayName: 'Gemini 1.5 Flash',
      inputTokenLimit: 1048576,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    });
    expect('object' in result.data[0]).toBe(false);
    // 上游没有 owned_by 时，不伪造 google/openai 等 owner。
    expect('owned_by' in result.data[1]).toBe(false);
  });

  it('claude 使用 /v1/models 分页，并可转换为 Gemini 模型列表格式', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      if (urls.length === 1) {
        return new Response(JSON.stringify({
          data: [
            {
              id: 'claude-opus-4-6',
              type: 'model',
              display_name: 'Claude Opus 4.6',
              created_at: '2026-02-04T00:00:00Z',
              max_input_tokens: 200000,
              max_tokens: 32000,
              capabilities: { image_input: { supported: true } },
            },
          ],
          has_more: true,
          last_id: 'claude-opus-4-6',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        data: [
          {
            id: 'claude-sonnet-4-6',
            type: 'model'
          },
        ],
        has_more: false,
        last_id: 'claude-sonnet-4-6',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await listAvailableModels({
      provider: 'claude',
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      outputFormat: 'gemini',
      fetch: fetchMock as any,
    });

    expect(urls).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-4-6',
    ]);
    expect(result.models.map(model => model.name)).toEqual([
      'models/claude-opus-4-6',
      'models/claude-sonnet-4-6',
    ]);
    expect(result.models[0]).toMatchObject({
      displayName: 'Claude Opus 4.6',
      inputTokenLimit: 200000,
      outputTokenLimit: 32000,
      modelType: 'model',
      createdAt: '2026-02-04T00:00:00Z',
      capabilities: { image_input: { supported: true } },
    });
    expect('supportedGenerationMethods' in result.models[0]).toBe(false);
    // 有的接口没有 display_name/displayName 时，直接使用 id。
    expect(result.models[1].displayName).toBe('claude-sonnet-4-6');
  });
});
