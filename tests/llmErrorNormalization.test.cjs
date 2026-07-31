const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isRetryableLlmRawError,
  messageFromRawError,
  rawErrorFromUnknown
} = require('../dist/extension/backend/capabilities/llmProvider.js');

test('LLM error 会优先展示嵌套的 provider 原始消息', () => {
  const message = messageFromRawError({
    kind: 'stream_error',
    message: 'LLM error',
    rawChunk: {
      type: 'error',
      error: {
        code: 'server_error',
        message: 'Upstream service is temporarily unavailable.'
      }
    }
  });

  assert.equal(message, 'Upstream service is temporarily unavailable.');
});

test('LLM error 在没有底层消息时使用结构化 WebSocket 关闭原因', () => {
  const message = messageFromRawError({
    kind: 'stream_read_error',
    message: 'LLM error',
    transport: 'websocket',
    phase: 'awaiting_first_event',
    closeCode: 1011,
    closeReason: 'upstream websocket proxy failed',
    retryable: true
  });

  assert.equal(message, 'OpenAI Responses WebSocket closed: 1011 upstream websocket proxy failed');
});

test('LLM error 在只有官方错误码时仍生成可诊断摘要', () => {
  const message = messageFromRawError({
    kind: 'stream_error',
    message: 'LLM error',
    code: 'invalid_api_key',
    status: 401,
    retryable: false
  });

  assert.equal(message, 'LLM 请求失败：invalid_api_key HTTP 401');
});

test('Error 转纯数据仅保留安全的 WebSocket 诊断字段', () => {
  const error = Object.assign(new Error('OpenAI Responses WebSocket closed'), {
    transport: 'websocket',
    phase: 'awaiting_first_event',
    closeCode: 1011,
    closeReason: 'upstream websocket proxy failed',
    closeWasClean: true,
    receivedServerEvent: false,
    attempt: 3,
    maxAttempts: 3,
    transportAttemptsExhausted: true,
    retryable: true,
    code: 'network_changed',
    apiKey: 'must-not-leak',
    headers: { authorization: 'must-not-leak' }
  });

  const raw = rawErrorFromUnknown(error);
  assert.equal(raw.transport, 'websocket');
  assert.equal(raw.phase, 'awaiting_first_event');
  assert.equal(raw.closeCode, 1011);
  assert.equal(raw.closeReason, 'upstream websocket proxy failed');
  assert.equal(raw.attempt, 3);
  assert.equal(raw.maxAttempts, 3);
  assert.equal(raw.transportAttemptsExhausted, true);
  assert.equal(raw.retryable, true);
  assert.equal(raw.code, 'network_changed');
  assert.equal(raw.apiKey, undefined);
  assert.equal(raw.headers, undefined);
});

test('LimCode 外层重试尊重 provider 的明确 retryable=false', () => {
  assert.equal(isRetryableLlmRawError({ retryable: false }), false);
  assert.equal(isRetryableLlmRawError({ retryable: true }), true);
  assert.equal(isRetryableLlmRawError(undefined), true);
});

test('底层传输已明确耗尽内部尝试时不再叠加 LimCode 外层重试', () => {
  assert.equal(isRetryableLlmRawError({
    transport: 'websocket',
    retryable: true,
    attempt: 3,
    maxAttempts: 3,
    transportAttemptsExhausted: true
  }), false);
});

test('快速断线后第二次超时但传输预算未耗尽时仍交给 LimCode 外层重试', () => {
  assert.equal(isRetryableLlmRawError({
    transport: 'websocket',
    retryable: true,
    attempt: 2,
    maxAttempts: 3,
    transportAttemptsExhausted: false
  }), true);
});

test('仅有 attempt/maxAttempts 而没有明确耗尽事实时不阻止外层重试', () => {
  assert.equal(isRetryableLlmRawError({
    transport: 'http',
    retryable: true,
    attempt: 3,
    maxAttempts: 3
  }), true);
});
