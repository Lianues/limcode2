const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  compactLlmProvider,
  dryRunLlmProvider
} = require('../dist/extension/backend/capabilities/llmProvider.js');
const {
  LlmEventType
} = require('../dist/extension/backend/world/modules/llm/events.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

function providerConfig(baseUrl, requestBody = {}) {
  return {
    id: 'provider-openai-responses',
    name: 'OpenAI Responses 测试渠道',
    provider: 'openai-responses',
    baseUrl,
    model: 'gpt-test',
    models: [{ id: 'gpt-test', name: 'gpt-test' }],
    apiKey: 'test-key',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: true,
    retryOnError: false,
    retryMaxAttempts: 0,
    enableMultimodalTools: true,
    systemPromptPrefix: '',
    headers: {
      'X-Codex-Beta-Features': 'existing_feature'
    },
    requestBody,
    modelConfigs: [],
    createdAt: 1,
    updatedAt: 1
  };
}

function compressionConfig() {
  return {
    id: 'compression-openai-native',
    name: 'OpenAI 原生压缩',
    kind: 'openai_responses_compact',
    trigger: { mode: 'manual', preserveLatestMessages: 8 },
    openaiResponsesCompact: {
      providerConfigId: 'provider-openai-responses',
      model: 'gpt-test'
    },
    createdAt: 1,
    updatedAt: 1
  };
}

function compactRequest() {
  return {
    id: 'compact-request-1',
    blockId: 'compression-block-1',
    conversationId: 'conversation-1',
    methodConfigId: 'compression-openai-native',
    methodKind: 'openai_responses_compact',
    contents: [
      { role: 'user', parts: [{ text: '第一条历史消息' }] },
      { role: 'model', parts: [{ text: '第一条模型回复' }] }
    ]
  };
}

function sseEvent(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

test('OpenAI 原生压缩通过普通 /responses SSE 触发 remote compaction v2', async () => {
  const requests = [];
  const compactionItem = {
    id: 'cmp_123',
    type: 'compaction',
    encrypted_content: 'encrypted-context-v2'
  };
  const server = http.createServer(async (request, response) => {
    const bodyText = await readRequestBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: JSON.parse(bodyText)
    });

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    sseEvent(response, 'response.output_item.done', {
      type: 'response.output_item.done',
      item: compactionItem
    });
    // completed 中重复携带同一个 compaction item，客户端应去重。
    sseEvent(response, 'response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_123',
        object: 'response',
        output: [compactionItem],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 0,
          total_tokens: 120
        }
      }
    });
    response.end('data: [DONE]\n\n');
  });
  await listen(server);

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const events = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = () => undefined;
  console.warn = () => undefined;

  try {
    await compactLlmProvider(
      compactRequest(),
      (event) => events.push(event),
      {
        settings: providerConfig(baseUrl, {
          metadata: {
            trace_id: 'trace-1',
            implementation: 'responses_compact'
          },
          model: '不应覆盖压缩模型',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '不应进入请求' }] }],
          stream: false,
          store: true,
          previous_response_id: 'resp_old',
          background: true,
          context_management: { compact_threshold: 1 },
          user: 'limcode-test'
        }),
        compressionSettings: compressionConfig
      }
    );
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    await close(server);
  }

  assert.equal(requests.length, 1);
  const captured = requests[0];
  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, '/v1/responses');
  assert.notEqual(captured.url, '/v1/responses/compact');

  const betaFeatures = String(captured.headers['x-codex-beta-features'])
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  assert.deepEqual(betaFeatures, ['existing_feature', 'remote_compaction_v2']);

  assert.equal(captured.body.model, 'gpt-test');
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.previous_response_id, undefined);
  assert.equal(captured.body.background, undefined);
  assert.equal(captured.body.context_management, undefined);
  assert.equal(captured.body.user, 'limcode-test');
  assert.deepEqual(captured.body.metadata, {
    trace_id: 'trace-1',
    implementation: 'responses_compaction_v2'
  });
  assert.equal(Array.isArray(captured.body.input), true);
  assert.equal(captured.body.input.length, 3);
  assert.deepEqual(captured.body.input.at(-1), { type: 'compaction_trigger' });
  assert.equal('encrypted_content' in captured.body.input.at(-1), false);

  const errorEvent = events.find((event) => event.type === LlmEventType.CompactError);
  assert.equal(errorEvent, undefined);
  const doneEvent = events.find((event) => event.type === LlmEventType.CompactDone);
  assert.notEqual(doneEvent, undefined);
  assert.equal(doneEvent.payload.result.object, 'response');
  assert.equal(doneEvent.payload.result.contents.length, 1, 'output_item.done 与 response.completed 的重复 item 应被去重');
  assert.deepEqual(doneEvent.payload.result.contents[0], {
    role: 'model',
    parts: [{
      providerContext: {
        provider: 'openai',
        format: 'openai-responses',
        endpoint: 'responses',
        itemType: 'compaction',
        id: 'cmp_123',
        encryptedContent: 'encrypted-context-v2',
        rawItem: compactionItem
      }
    }]
  });
  assert.deepEqual(doneEvent.payload.result.rawResponse, compactionItem);
  assert.deepEqual(doneEvent.payload.result.usageMetadata, {
    promptTokenCount: 120,
    cachedContentTokenCount: 20,
    candidatesTokenCount: 0,
    totalTokenCount: 120
  });

  const replayDryRun = await dryRunLlmProvider({
    id: 'replay-request-1',
    conversationId: 'conversation-1',
    contents: [
      ...doneEvent.payload.result.contents,
      { role: 'user', parts: [{ text: '继续处理' }] }
    ],
    tools: []
  }, {
    settings: providerConfig(baseUrl)
  });
  assert.deepEqual(replayDryRun.body.input[0], compactionItem, '后续普通 /responses 请求应原样回放 compaction item');
});

test('remote compaction v2 未返回 compaction item 时明确失败且不降级', async () => {
  const server = http.createServer(async (request, response) => {
    await readRequestBody(request);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache'
    });
    sseEvent(response, 'response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_without_compaction',
        object: 'response',
        output: [],
        usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 }
      }
    });
    response.end('data: [DONE]\n\n');
  });
  await listen(server);

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const events = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = () => undefined;
  console.warn = () => undefined;

  try {
    await compactLlmProvider(
      compactRequest(),
      (event) => events.push(event),
      {
        settings: providerConfig(`http://127.0.0.1:${address.port}/v1`),
        compressionSettings: compressionConfig
      }
    );
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    await close(server);
  }

  assert.equal(events.some((event) => event.type === LlmEventType.CompactDone), false);
  const errorEvent = events.find((event) => event.type === LlmEventType.CompactError);
  assert.notEqual(errorEvent, undefined);
  assert.match(errorEvent.payload.message, /未返回 compaction item/);
  assert.equal(errorEvent.payload.retryMaxAttempts, 0);
});
