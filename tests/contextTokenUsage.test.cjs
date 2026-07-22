const assert = require('node:assert/strict');
const test = require('node:test');
const {
  resolveContextUsage
} = require('../dist/extension/shared/contextTokenUsage.js');

function provider() {
  return {
    id: 'provider-1',
    name: 'codex个人反代',
    provider: 'openai-responses',
    baseUrl: 'https://example.invalid',
    model: 'gpt-5.5-codex',
    models: [
      { id: 'gpt-5.5-codex', name: 'gpt-5.5-codex' },
      { id: 'gpt-5.6-sol-codex', name: 'gpt-5.6-sol-codex' }
    ],
    apiKey: '',
    toolCallFormat: 'function-call',
    stream: true,
    retryOnError: true,
    retryMaxAttempts: 3,
    enableMultimodalTools: true,
    contextWindowTokens: 372_000,
    modelConfigs: [{
      id: 'model-config-55',
      modelId: 'gpt-5.5-codex',
      toolCallFormat: 'function-call',
      stream: true,
      retryOnError: true,
      retryMaxAttempts: 3,
      enableMultimodalTools: true,
      contextWindowTokens: 272_000,
      createdAt: 1,
      updatedAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
}

function compressionConfig(id, thresholdTokens) {
  return {
    id,
    name: id,
    kind: 'openai_responses_compact',
    trigger: {
      mode: 'token_threshold',
      thresholdUnit: 'tokens',
      thresholdTokens,
      thresholdPercent: thresholdTokens / (thresholdTokens === 252_000 ? 272_000 : 372_000) * 100,
      preserveLatestMessages: 8,
      reserveLatestUserMessageTokens: 20_000
    },
    createdAt: 1,
    updatedAt: 1
  };
}

function message(id, seq, model, totalTokenCount, extraUsage = {}) {
  return {
    id,
    conversationId: 'conversation-1',
    role: 'model',
    model,
    content: { role: 'model', parts: [{ text: id }] },
    status: 'complete',
    seq,
    createdAt: seq,
    usageMetadata: { totalTokenCount, ...extraUsage }
  };
}

function baseInput() {
  return {
    messages: [message('model-56', 2, 'gpt-5.6-sol-codex', 368_301)],
    llmInvocations: [],
    messageLlmInvocationLinks: [],
    providerConfigs: [provider()],
    compressionSettings: {
      defaultConfigId: 'compression-default',
      providerBindings: [{
        id: 'provider-binding',
        providerConfigId: 'provider-1',
        compressionConfigId: 'compression-provider',
        role: 'default',
        createdAt: 1,
        updatedAt: 1
      }],
      modelBindings: [{
        id: 'model-binding',
        providerConfigId: 'provider-1',
        modelId: 'gpt-5.5-codex',
        compressionConfigId: 'compression-55',
        role: 'model',
        createdAt: 1,
        updatedAt: 1
      }]
    },
    compressionConfigs: [
      compressionConfig('compression-default', 200_000),
      compressionConfig('compression-provider', 352_000),
      compressionConfig('compression-55', 252_000)
    ],
    preferredProviderConfigId: 'provider-1'
  };
}

test('token 百分比优先使用产生 usage 的 invocation 快照，而不是当前模型配置', () => {
  const input = baseInput();
  input.llmInvocations = [{
    id: 'invocation-56',
    requestId: 'request-56',
    status: 'complete',
    settings: {
      providerConfigId: 'provider-1',
      providerConfigName: 'codex个人反代',
      provider: 'openai-responses',
      modelId: 'gpt-5.6-sol-codex',
      contextWindowTokens: 272_000,
      compressionConfigId: 'old-provider-compression',
      compressionMethodKind: 'openai_responses_compact',
      compressionTrigger: {
        mode: 'token_threshold',
        thresholdUnit: 'tokens',
        thresholdTokens: 252_000,
        thresholdPercent: 92.6,
        preserveLatestMessages: 8,
        reserveLatestUserMessageTokens: 20_000
      }
    },
    usageMetadata: { totalTokenCount: 368_301 },
    createdAt: 1,
    completedAt: 2
  }];
  input.messageLlmInvocationLinks = [{
    id: 'message-invocation-56',
    messageId: 'model-56',
    invocationId: 'invocation-56',
    role: 'modelOutput',
    createdAt: 1,
    updatedAt: 2
  }];

  const result = resolveContextUsage(input);
  assert.equal(result.settingsSource, 'invocation');
  assert.equal(result.totalTokens, 368_301);
  assert.equal(result.modelId, 'gpt-5.6-sol-codex');
  assert.equal(result.contextWindowTokens, 272_000);
  assert.equal(result.compressionTrigger.thresholdTokens, 252_000);
});

test('历史 invocation 不可用时按消息实际模型匹配配置，不套用当前默认模型的专属配置', () => {
  const result = resolveContextUsage(baseInput());
  assert.equal(result.settingsSource, 'message_model');
  assert.equal(result.modelId, 'gpt-5.6-sol-codex');
  assert.equal(result.contextWindowTokens, 372_000);
  assert.equal(result.compressionTrigger.thresholdTokens, 352_000);
  assert.notEqual(result.compressionTrigger.thresholdTokens, 252_000);
});

test('manual/disabled 压缩配置不显示为自动压缩阈值', () => {
  const input = baseInput();
  input.llmInvocations = [{
    id: 'manual-invocation',
    requestId: 'manual-request',
    status: 'complete',
    settings: {
      providerConfigId: 'provider-1',
      modelId: 'gpt-5.6-sol-codex',
      contextWindowTokens: 372_000,
      compressionMethodKind: 'disabled',
      compressionTrigger: {
        mode: 'token_threshold',
        thresholdUnit: 'tokens',
        thresholdTokens: 352_000,
        thresholdPercent: 94.6,
        preserveLatestMessages: 8,
        reserveLatestUserMessageTokens: 20_000
      }
    },
    usageMetadata: { totalTokenCount: 368_301 },
    createdAt: 1,
    completedAt: 2
  }];
  input.messageLlmInvocationLinks = [{
    id: 'manual-link',
    messageId: 'model-56',
    invocationId: 'manual-invocation',
    role: 'modelOutput',
    createdAt: 1,
    updatedAt: 2
  }];

  const result = resolveContextUsage(input);
  assert.equal(result.settingsSource, 'invocation');
  assert.equal(result.compressionTrigger, undefined);
});

test('估算 usage 不作为真实上下文百分比来源', () => {
  const input = baseInput();
  input.messages = [
    message('actual', 1, 'gpt-5.6-sol-codex', 100_000),
    message('estimated', 2, 'gpt-5.5-codex', 999_999, { estimated: true, tokenEstimator: 'tokenx' })
  ];
  const result = resolveContextUsage(input);
  assert.equal(result.message.id, 'actual');
  assert.equal(result.totalTokens, 100_000);
  assert.equal(result.modelId, 'gpt-5.6-sol-codex');
});
