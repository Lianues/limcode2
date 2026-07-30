import { describe, expect, it } from 'vitest';

import {
  createClaudeProvider,
  createDeepSeekProvider,
  createGeminiProvider,
  createOpenAICompatibleProvider,
  createOpenAIResponsesProvider,
} from '../src/index.js';
import type { LLMRequest } from '../src/index.js';

const request: LLMRequest = {
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  generationConfig: {
    temperature: 0.1,
    topP: 0.2,
    topK: 16,
    maxOutputTokens: 128,
  },
};

describe('unified generation params', () => {
  it('OpenAI compatible 映射 temperature/topP/maxOutputTokens，topK 默认不映射，requestBody 覆盖统一参数', async () => {
    const provider = createOpenAICompatibleProvider({
      provider: 'openai-compatible',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      requestBody: {
        temperature: 0.9,
        top_p: 0.8,
        max_tokens: 512,
        custom_flag: true,
      },
    });

    const dry = await provider.dryRun(request, { stream: false });
    const body = dry.body as any;

    expect(body).toMatchObject({
      temperature: 0.9,
      top_p: 0.8,
      max_tokens: 512,
      custom_flag: true,
    });
    expect(body.top_k).toBeUndefined();
  });

  it('OpenAI Responses 映射 temperature/topP/maxOutputTokens，requestBody 可覆盖 max_output_tokens', async () => {
    const provider = createOpenAIResponsesProvider({
      provider: 'openai-responses',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      requestBody: {
        max_output_tokens: 256,
      },
    });

    const dry = await provider.dryRun(request, { stream: false });
    const body = dry.body as any;

    expect(body.temperature).toBe(0.1);
    expect(body.top_p).toBe(0.2);
    expect(body.max_output_tokens).toBe(256);
    expect(body.top_k).toBeUndefined();
  });

  it('OpenAI Responses key 模式只发送 prompt_cache_key，不发送显式断点或时间参数', async () => {
    const provider = createOpenAIResponsesProvider({
      provider: 'openai-responses',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      promptCache: { enabled: true, mode: 'key', key: 'limcode:test-cache-key' },
    });

    const dry = await provider.dryRun({
      systemInstruction: { parts: [{ text: 'stable system prompt' }] },
      tools: [{
        functionDeclarations: [{
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        }],
      }],
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } satisfies LLMRequest, { stream: false });

    const body = dry.body as any;
    expect(body.instructions).toBe('stable system prompt');
    expect(body.tools.at(-1).cache_control).toBeUndefined();
    expect(body.prompt_cache_key).toBe('limcode:test-cache-key');
    expect(body.prompt_cache_options).toBeUndefined();
    expect(body.input).toHaveLength(1);
    expect(body.input[0].content.at(-1).prompt_cache_breakpoint).toBeUndefined();
  });

  it('OpenAI Responses breakpoint 模式发送 prompt_cache_options 和聊天记录末尾断点', async () => {
    const provider = createOpenAIResponsesProvider({
      provider: 'openai-responses',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      promptCache: { enabled: true, mode: 'explicit', key: 'limcode:test-cache-key' },
    });

    const dry = await provider.dryRun({
      systemInstruction: { parts: [{ text: 'stable system prompt' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } satisfies LLMRequest, { stream: false });

    const body = dry.body as any;
    expect(body.prompt_cache_key).toBe('limcode:test-cache-key');
    expect(body.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' });
    expect(body.input[0].content.at(-1).prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
  });

  it('Claude 注入 Prompt Cache 三断点并使用 1h TTL', async () => {
    const provider = createClaudeProvider({
      provider: 'claude',
      model: 'claude-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.test/v1',
      promptCache: { enabled: true, ttl: '1h' },
    });

    const dry = await provider.dryRun({
      systemInstruction: { parts: [{ text: 'stable system prompt' }] },
      tools: [{
        functionDeclarations: [{
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        }],
      }],
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } satisfies LLMRequest, { stream: false });

    const body = dry.body as any;
    const cacheControl = { type: 'ephemeral', ttl: '1h' };
    expect(body.tools.at(-1).cache_control).toEqual(cacheControl);
    expect(body.system.at(-1).cache_control).toEqual(cacheControl);
    expect(body.messages.at(-1).content.at(-1).cache_control).toEqual(cacheControl);
  });

  it('Claude 映射 temperature/topP/topK/maxOutputTokens，静态 requestBody 覆盖统一参数，运行时 patch 再覆盖静态 requestBody', async () => {
    const provider = createClaudeProvider({
      provider: 'claude',
      model: 'claude-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.test/v1',
      requestBody: {
        temperature: 0.5,
        top_p: 0.6,
        top_k: 32,
        max_tokens: 1024,
      },
    });

    provider.patchRequestBodyOverrides({
      temperature: 0.7,
      top_p: 0.75,
    });

    const dry = await provider.dryRun(request, { stream: false });
    const body = dry.body as any;

    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.75);
    expect(body.top_k).toBe(32);
    expect(body.max_tokens).toBe(1024);
  });

  it('Gemini 保持 generationConfig 的 Gemini 风格字段，requestBody.generationConfig 深合并并覆盖统一参数', async () => {
    const provider = createGeminiProvider({
      provider: 'gemini',
      model: 'gemini-test',
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      requestBody: {
        generationConfig: {
          temperature: 0.3,
          topP: 0.4,
          topK: 24,
          maxOutputTokens: 256,
        },
      },
    });

    const dry = await provider.dryRun(request, { stream: false });
    const body = dry.body as any;

    expect(body.generationConfig).toMatchObject({
      temperature: 0.3,
      topP: 0.4,
      topK: 24,
      maxOutputTokens: 256,
    });
  });

  it('Gemini thinkingBudget/thinkingLevel 在未显式设置 includeThoughts 时会自动补 includeThoughts=true', async () => {
    const provider = createGeminiProvider({
      provider: 'gemini',
      model: 'gemini-test',
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });

    const dry = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: 10000,
          thinkingLevel: 'high',
        },
      },
    } satisfies LLMRequest, { stream: false });
    const body = dry.body as any;

    expect(body.generationConfig.thinkingConfig).toMatchObject({
      thinkingBudget: 10000,
      thinkingLevel: 'high',
      includeThoughts: true,
    });
  });

  it('Gemini 显式传 includeThoughts=false 时保留 false，不会因 thinkingBudget 自动改成 true', async () => {
    const provider = createGeminiProvider({
      provider: 'gemini',
      model: 'gemini-test',
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });

    const dry = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: {
        thinkingConfig: {
          includeThoughts: false,
          thinkingBudget: 10000,
          thinkingLevel: 'high',
        },
      },
    } satisfies LLMRequest, { stream: false });
    const body = dry.body as any;

    expect(body.generationConfig.thinkingConfig).toMatchObject({
      thinkingBudget: 10000,
      thinkingLevel: 'high',
      includeThoughts: false,
    });
  });

  it('Gemini 不支持的 thinkingLevel 视为 non-set，不发送 thinkingConfig', async () => {
    const provider = createGeminiProvider({
      provider: 'gemini',
      model: 'gemini-test',
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });

    const dry = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: 'max',
        },
      },
    } satisfies LLMRequest, { stream: false });

    expect((dry.body as any).generationConfig?.thinkingConfig).toBeUndefined();
  });


  it('Claude 将 thinkingBudget 映射为 thinking.enabled + budget_tokens，并忽略 includeThoughts', async () => {
    const provider = createClaudeProvider({
      provider: 'claude',
      model: 'claude-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.test/v1',
    });

    const dry = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: {
        thinkingConfig: {
          includeThoughts: false,
          thinkingBudget: 10000,
        },
      },
    } satisfies LLMRequest, { stream: false });
    const body = dry.body as any;

    expect(body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 10000,
    });
    expect(JSON.stringify(body)).not.toContain('includeThoughts');
  });

  it('Claude 将支持的 thinkingLevel 映射为 adaptive effort / disabled，unsupported level 视为 non-set', async () => {
    const provider = createClaudeProvider({
      provider: 'claude',
      model: 'claude-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.test/v1',
    });

    const high = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
    } satisfies LLMRequest, { stream: false });

    expect((high.body as any).thinking).toEqual({ type: 'adaptive' });
    expect((high.body as any).output_config).toEqual({ effort: 'high' });

    const none = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'none' } },
    } satisfies LLMRequest, { stream: false });

    expect((none.body as any).thinking).toEqual({ type: 'disabled' });
    expect((none.body as any).output_config).toBeUndefined();

    const unsupported = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } },
    } satisfies LLMRequest, { stream: false });

    expect((unsupported.body as any).thinking).toBeUndefined();
    expect((unsupported.body as any).output_config).toBeUndefined();
  });

  it('OpenAI compatible 将支持的 thinkingLevel 映射为 reasoning_effort，unsupported level 视为 non-set', async () => {
    const provider = createOpenAICompatibleProvider({
      provider: 'openai-compatible',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
    });

    const dry = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: 'medium',
        },
      },
    } satisfies LLMRequest, { stream: false });
    expect((dry.body as any).reasoning_effort).toBe('medium');

    const maxLevel = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'max' } },
    } satisfies LLMRequest, { stream: false });

    expect((maxLevel.body as any).reasoning_effort).toBe('max');

    const unsupported = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'unknown' } },
    } satisfies LLMRequest, { stream: false });

    expect((unsupported.body as any).reasoning_effort).toBeUndefined();
  });

  it('OpenAI Responses 将支持的 thinkingLevel 映射为 reasoning.effort + summary=auto', async () => {
    const provider = createOpenAIResponsesProvider({
      provider: 'openai-responses',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
    });

    const dry = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
    } satisfies LLMRequest, { stream: false });

    expect((dry.body as any).reasoning).toEqual({
      effort: 'high',
      summary: 'detailed',
    });

    const maxLevel = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'max' } },
    } satisfies LLMRequest, { stream: false });

    expect((maxLevel.body as any).reasoning).toEqual({
      effort: 'max',
      summary: 'detailed',
    });
  });

  it('OpenAI Responses 将 reasoningMode 映射为 reasoning.mode', async () => {
    const provider = createOpenAIResponsesProvider({
      provider: 'openai-responses',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
    });

    const dry = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: 'medium',
          reasoningMode: 'pro',
        },
      },
    } satisfies LLMRequest, { stream: false });

    expect((dry.body as any).reasoning).toEqual({
      mode: 'pro',
      effort: 'medium',
      summary: 'detailed',
    });

    const modeOnly = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: {
        thinkingConfig: {
          reasoningMode: 'standard',
        },
      },
    } satisfies LLMRequest, { stream: false });

    expect((modeOnly.body as any).reasoning).toEqual({
      mode: 'standard',
    });

    const invalidMode = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: {
        thinkingConfig: {
          reasoningMode: 'invalid',
        },
      },
    } satisfies LLMRequest, { stream: false });

    expect((invalidMode.body as any).reasoning).toBeUndefined();
  });

  it('DeepSeek 只映射 none/high/max thinkingLevel，其它等级视为 non-set', async () => {
    const provider = createDeepSeekProvider({
      provider: 'deepseek',
      model: 'deepseek-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.test/v1',
    });

    const high = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
    } satisfies LLMRequest, { stream: false });

    expect((high.body as any).thinking).toEqual({ type: 'enabled' });
    expect((high.body as any).reasoning_effort).toBe('high');

    const none = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'none' } },
    } satisfies LLMRequest, { stream: false });

    expect((none.body as any).thinking).toEqual({ type: 'disabled' });
    expect((none.body as any).reasoning_effort).toBeUndefined();

    const unsupported = await provider.dryRun({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } },
    } satisfies LLMRequest, { stream: false });

    expect((unsupported.body as any).thinking).toBeUndefined();
    expect((unsupported.body as any).reasoning_effort).toBeUndefined();
  });

});
