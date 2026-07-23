import type { LlmProviderConfigRecord } from '../../shared/protocol';
import type { LlmModelSettings } from '../world/modules/llm/contracts';

export interface RequestedModelOverrideResolution {
  config: LlmProviderConfigRecord;
  applied: boolean;
}

/** 将本次 ChatSend/retry/edit 显式携带的模型应用到 provider 配置，并返回它是否成为权威值。 */
export function applyRequestedModelOverride(
  base: LlmProviderConfigRecord,
  override: LlmModelSettings | undefined,
  overrideProviderConfigResolved: boolean
): RequestedModelOverrideResolution {
  const overrideModel = override?.model?.trim();
  const applied = !!overrideModel
    && (!override?.providerConfigId || overrideProviderConfigResolved)
    && modelExistsInConfig(base, overrideModel);
  if (!applied) return { config: base, applied: false };
  return {
    config: {
      ...base,
      ...(override?.provider ? { provider: override.provider } : {}),
      model: overrideModel!
    },
    applied: true
  };
}

/** 命中模型专属配置时整体替代渠道默认高级配置。 */
export function applyModelSpecificConfig(config: LlmProviderConfigRecord): LlmProviderConfigRecord {
  const modelId = config.model.trim();
  const modelConfig = modelId ? config.modelConfigs.find((candidate) => candidate.modelId === modelId) : undefined;
  if (!modelConfig) return config;
  const next: LlmProviderConfigRecord = {
    ...config,
    toolCallFormat: modelConfig.toolCallFormat,
    openaiResponsesTransport: modelConfig.openaiResponsesTransport,
    stream: modelConfig.stream,
    retryOnError: modelConfig.retryOnError,
    retryMaxAttempts: modelConfig.retryMaxAttempts,
    enableMultimodalTools: modelConfig.enableMultimodalTools,
    contextWindowTokens: modelConfig.contextWindowTokens,
    promptCache: modelConfig.promptCache
  };

  if (modelConfig.headers) next.headers = modelConfig.headers;
  else delete next.headers;
  if (modelConfig.generationConfig) next.generationConfig = modelConfig.generationConfig;
  else delete next.generationConfig;
  if (modelConfig.requestBody) next.requestBody = modelConfig.requestBody;
  else delete next.requestBody;
  return next;
}

export function modelExistsInConfig(config: LlmProviderConfigRecord, model: string): boolean {
  const id = model.trim();
  if (!id) return false;
  return config.model?.trim() === id || config.models.some((candidate) => candidate.id.trim() === id);
}
