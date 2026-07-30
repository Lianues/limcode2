import { describe, expect, it, vi } from 'vitest';

import {
  bodyToCurlPayload,
  formatRequestAsCurl,
  formatResponseForLog,
  createTraceDebugHooks,
  type DebugTraceStore,
} from '../src/index.js';
import { createClaudeProvider } from '../src/index.js';

describe('debug utils', () => {
  it('formatRequestAsCurl 可生成标准 curl 命令', () => {
    const curl = formatRequestAsCurl(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': 'sk-test', 'content-type': 'application/json' },
      { model: 'claude-sonnet-4', max_tokens: 256, messages: [{ role: 'user', content: 'hello' }] },
    );

    expect(curl).toContain("curl -X POST");
    expect(curl).toContain("https://api.anthropic.com/v1/messages");
    expect(curl).toContain("claude-sonnet-4");
    expect(curl).toContain('max_tokens');
  });

  it('formatRequestAsCurl 可隐藏 API Key', () => {
    const curl = formatRequestAsCurl(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': 'sk-secret', 'content-type': 'application/json' },
      { model: 'claude' },
      { includeApiKey: false },
    );

    expect(curl).not.toContain('sk-secret');
    expect(curl).toContain('***');
  });

  it('formatRequestAsCurl pretty body 保留真实换行，不输出字面量 \\n', () => {
    const curl = formatRequestAsCurl(
      'https://example.com',
      { 'content-type': 'application/json' },
      { model: 'test', messages: [{ role: 'user', content: 'hello' }] },
    );

    expect(curl).toContain("-d '{\n");
    expect(curl).not.toContain("-d '{\\n");
  });

  it('formatRequestAsCurl compact body 不应把 JSON 对象二次 stringify 成字符串', () => {
    const curl = formatRequestAsCurl(
      'https://example.com',
      { 'content-type': 'application/json' },
      { model: 'test' },
      { prettyBody: false },
    );

    expect(curl).toContain(`-d '{"model":"test"}'`);
    expect(curl).not.toContain(`-d '"{`);
  });

  it('bodyToCurlPayload 可美化 body 输出', () => {
    const body = bodyToCurlPayload({ model: 'test', messages: [{ role: 'user' }] });
    expect(body).toContain('"model"');
    expect(body).toContain('"messages"');
    expect(body.split('\n').length).toBeGreaterThan(1);
  });

  it('formatResponseForLog 可格式化响应', () => {
    const log = formatResponseForLog({
      url: 'https://api.anthropic.com/v1/messages',
      stream: false,
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
      bodyText: JSON.stringify({ type: 'message', content: 'hello' }),
    });

    expect(log).toContain('HTTP 200');
    expect(log).toContain('x-request-id');
    expect(log).toContain('content-type');
  });

  it('createTraceDebugHooks 可记录 trace 并把数据交给调用方', async () => {
    const traceStore = {} as DebugTraceStore;
    const hooks = createTraceDebugHooks(traceStore);

    await hooks.onRequest!({ url: 'https://example.com', stream: false, headers: {}, body: { model: 'test' } });
    expect(traceStore.request).toBeDefined();
    expect(traceStore.request!.curl).toContain('curl -X POST');

    await hooks.onResponse!({ url: 'https://example.com', stream: false, status: 200, headers: {}, bodyText: 'ok' });
    expect(traceStore.response).toBeDefined();
    expect(traceStore.response!.status).toBe(200);

    // 流式 chunk 也能记录
    await hooks.onStreamChunk!({ url: 'https://example.com', chunk: 'data: hello', accumulated: 'data: hello' });
  });

  it('provider 支持通过 debug 配置记录请求/响应到 traceStore', async () => {
    const traceStore = {} as DebugTraceStore;
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const provider = createClaudeProvider({
      provider: 'claude',
      model: 'claude-sonnet-4',
      apiKey: 'test-key',
      baseUrl: 'https://api.anthropic.com/v1',
      debug: createTraceDebugHooks(traceStore),
      fetch: mockFetch as any,
    });

    const response = await provider.chat({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    }, { inputFormat: 'unified', outputFormat: 'unified' });

    expect(traceStore.request).toBeDefined();
    expect(traceStore.request!.curl).toContain('curl -X POST');
    expect(traceStore.response).toBeDefined();
    expect(traceStore.response!.status).toBe(200);
  });
});
