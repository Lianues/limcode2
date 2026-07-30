import { describe, expect, it, vi } from 'vitest';

import {
  createClaudeProvider,
  createOpenAICompatibleProvider,
  decodeResponseFromFormat,
} from '../src/index.js';
import type { LLMRequest } from '../src/index.js';

const request: LLMRequest = {
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
};

describe('upstream error passthrough', () => {
  it('不会把 OpenAI Responses 的 error:null 成功响应误判为错误', () => {
    const response = decodeResponseFromFormat({
      id: 'resp_123',
      status: 'completed',
      error: null,
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
      ],
    }, { format: 'openai-responses', model: 'gpt-test' }) as any;

    expect(response.error).toBeUndefined();
    expect(response.content.parts).toEqual([{ text: 'done' }]);
  });

  it('非流式 HTTP 错误不再抛出，统一输出里透传 status / headers / 原始响应体', async () => {
    const rawError = { error: { type: 'invalid_request_error', message: 'bad request' } };
    const mockFetch = vi.fn(async () => new Response(JSON.stringify(rawError), {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_123' },
    }));

    const provider = createOpenAICompatibleProvider({
      provider: 'openai-compatible',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      fetch: mockFetch as any,
    });

    const response = await provider.chat(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
    }) as any;

    expect(response.error).toMatchObject({
      kind: 'http_error',
      status: 400,
      statusText: 'Bad Request',
      rawBody: rawError,
    });
    expect(response.error.headers['x-request-id']).toBe('req_123');
    expect(response.error.bodyText).toBe(JSON.stringify(rawError));
    expect(response.rawResponse).toEqual(rawError);
    expect(response.content.parts).toEqual([{ text: '' }]);
  });

  it('非 unified 输出遇到 HTTP 错误时直接返回上游原始响应体', async () => {
    const rawError = { error: { message: 'rate limited', code: 'rate_limit_exceeded' } };
    const mockFetch = vi.fn(async () => new Response(JSON.stringify(rawError), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    }));

    const provider = createOpenAICompatibleProvider({
      provider: 'openai-compatible',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      fetch: mockFetch as any,
    });

    const response = await provider.chat(request, {
      inputFormat: 'unified',
      outputFormat: 'openai-compatible',
    });

    expect(response).toEqual(rawError);
  });

  it('流式 HTTP 错误产出一个 error chunk，并透传原始响应体', async () => {
    const rawError = { error: { message: 'too many requests' } };
    const mockFetch = vi.fn(async () => new Response(JSON.stringify(rawError), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'Content-Type': 'application/json' },
    }));

    const provider = createOpenAICompatibleProvider({
      provider: 'openai-compatible',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      fetch: mockFetch as any,
    });

    const chunks: any[] = [];
    for await (const chunk of provider.chatStream(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].error).toMatchObject({
      kind: 'http_error',
      status: 429,
      statusText: 'Too Many Requests',
      rawBody: rawError,
    });
    expect(chunks[0].rawChunk).toEqual(rawError);
  });

  it('200 OK 的 SSE 错误块不再静默吞掉，而是原生透传给前端', async () => {
    const rawError = { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } };
    const mockFetch = vi.fn(async () => new Response(
      `event: error\ndata: ${JSON.stringify(rawError)}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));

    const provider = createClaudeProvider({
      provider: 'claude',
      model: 'claude-sonnet-4',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.test/v1',
      fetch: mockFetch as any,
    });

    const chunks: any[] = [];
    for await (const chunk of provider.chatStream(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].error).toMatchObject({
      kind: 'stream_error',
      event: 'error',
      rawChunk: { ...rawError, event: 'error' },
    });
    expect(chunks[0].rawChunk).toEqual({ ...rawError, event: 'error' });
  });

  it('可解析冒号后无空格的 Claude SSE，并保留 thinking 后续 text block', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '思考' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    const bodyText = events
      .map((event) => `event:${event.type}\ndata:${JSON.stringify(event)}\n\n`)
      .join('');
    const mockFetch = vi.fn(async () => new Response(bodyText, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const provider = createClaudeProvider({
      provider: 'claude',
      model: 'claude-sonnet-4',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.test/v1',
      fetch: mockFetch as any,
    });

    const chunks: any[] = [];
    for await (const chunk of provider.chatStream(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.partsDelta?.[0]?.text === '思考' && chunk.partsDelta[0].thought === true)).toBe(true);
    expect(chunks.some((chunk) => chunk.thoughtSignature === 'claude:sig_1' || chunk.partsDelta?.[0]?.thoughtSignature === 'claude:sig_1')).toBe(true);
    expect(chunks.some((chunk) => chunk.textDelta === '你好')).toBe(true);
  });

  it('SSE data 不是 JSON 时返回 stream_parse_error，保留 data 原文', async () => {
    const mockFetch = vi.fn(async () => new Response(
      'data: upstream plain text error\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));

    const provider = createOpenAICompatibleProvider({
      provider: 'openai-compatible',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      fetch: mockFetch as any,
    });

    const chunks: any[] = [];
    for await (const chunk of provider.chatStream(request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].error).toMatchObject({
      kind: 'stream_parse_error',
      data: 'upstream plain text error',
      bodyText: 'upstream plain text error',
    });
    expect(chunks[0].rawChunk).toBe('upstream plain text error');
  });

  it('非 unified 流式输出遇到错误块时直接返回上游原始 chunk', async () => {
    const rawError = { error: { message: 'bad upstream chunk' } };
    const mockFetch = vi.fn(async () => new Response(
      `data: ${JSON.stringify(rawError)}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));

    const provider = createOpenAICompatibleProvider({
      provider: 'openai-compatible',
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.test/v1',
      fetch: mockFetch as any,
    });

    const chunks: any[] = [];
    for await (const chunk of provider.chatStream(request, {
      inputFormat: 'unified',
      outputFormat: 'openai-compatible',
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([rawError]);
  });
});
