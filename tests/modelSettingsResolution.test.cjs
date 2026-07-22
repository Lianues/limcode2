const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyModelSpecificConfig,
  applyRequestedModelOverride
} = require('../dist/extension/backend/application/llmSettingsResolution.js');

function providerConfig() {
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

test('显式请求模型优先于可能迟到的 conversation override', () => {
  const base = providerConfig();
  const requested = applyRequestedModelOverride(base, {
    providerConfigId: 'provider-1',
    provider: 'openai-responses',
    model: 'gpt-5.6-sol-codex'
  }, true);

  assert.equal(requested.applied, true);
  assert.equal(requested.config.model, 'gpt-5.6-sol-codex');
  const resolved = applyModelSpecificConfig(requested.config);
  assert.equal(resolved.contextWindowTokens, 372_000, '无专属配置模型应使用渠道默认配置');
});

test('有模型专属配置时整体应用该模型配置', () => {
  const base = providerConfig();
  const requested = applyRequestedModelOverride(base, {
    providerConfigId: 'provider-1',
    provider: 'openai-responses',
    model: 'gpt-5.5-codex'
  }, true);
  const resolved = applyModelSpecificConfig(requested.config);

  assert.equal(requested.applied, true);
  assert.equal(resolved.model, 'gpt-5.5-codex');
  assert.equal(resolved.contextWindowTokens, 272_000);
});

test('provider 配置未解析或模型不存在时不错误应用显式模型', () => {
  const base = providerConfig();
  const unresolvedProvider = applyRequestedModelOverride(base, {
    providerConfigId: 'missing-provider',
    provider: 'openai-responses',
    model: 'gpt-5.6-sol-codex'
  }, false);
  const missingModel = applyRequestedModelOverride(base, {
    providerConfigId: 'provider-1',
    provider: 'openai-responses',
    model: 'not-exists'
  }, true);

  assert.equal(unresolvedProvider.applied, false);
  assert.equal(unresolvedProvider.config.model, 'gpt-5.5-codex');
  assert.equal(missingModel.applied, false);
  assert.equal(missingModel.config.model, 'gpt-5.5-codex');
});
