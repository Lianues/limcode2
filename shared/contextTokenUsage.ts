import type {
  LlmCompressionConfigRecord,
  LlmCompressionMethodKind,
  LlmCompressionSettingsRecord,
  LlmInvocationRecord,
  LlmProviderConfigRecord,
  LlmProviderModelConfigRecord,
  LlmUsageMetadataRecord,
  MessageLlmInvocationLinkRecord,
  MessageRecord
} from './protocol';

const TOTAL_TOKEN_KEYS = ['totalTokenCount', 'total_tokens', 'totalTokens'] as const;
const INPUT_TOKEN_KEYS = ['promptTokenCount', 'prompt_tokens', 'input_tokens', 'inputTokens'] as const;
const OUTPUT_TOKEN_KEYS = ['candidatesTokenCount', 'completion_tokens', 'output_tokens', 'outputTokens'] as const;
const REASONING_TOKEN_KEYS = ['thoughtsTokenCount', 'reasoning_tokens'] as const;

export type ContextUsageSettingsSource = 'invocation' | 'message_model' | 'unavailable';

export interface ContextUsageResolution {
  message?: MessageRecord;
  totalTokens?: number;
  invocation?: LlmInvocationRecord;
  providerConfig?: LlmProviderConfigRecord;
  modelId?: string;
  modelConfig?: LlmProviderModelConfigRecord;
  contextWindowTokens?: number;
  compressionTrigger?: LlmCompressionConfigRecord['trigger'];
  settingsSource: ContextUsageSettingsSource;
}

export interface ResolveContextUsageInput {
  messages: readonly MessageRecord[];
  llmInvocations: readonly LlmInvocationRecord[];
  messageLlmInvocationLinks: readonly MessageLlmInvocationLinkRecord[];
  providerConfigs: readonly LlmProviderConfigRecord[];
  compressionSettings: LlmCompressionSettingsRecord;
  compressionConfigs: readonly LlmCompressionConfigRecord[];
}

/**
 * 解析“最近一次真实模型 usage”对应的配置。
 *
 * 首选 Message -> LlmInvocation link 中的不可变 settings snapshot；重启后若普通 invocation 未保留，
 * 才按消息自身的 model 标签解析 provider/model。绝不直接套用当前下拉框刚选择的模型。
 */
export function resolveContextUsage(input: ResolveContextUsageInput): ContextUsageResolution {
  const latest = latestActualModelUsage(input.messages);
  if (!latest) return { settingsSource: 'unavailable' };

  const invocation = invocationForMessage(latest.message.id, input.messageLlmInvocationLinks, input.llmInvocations);
  const snapshot = invocation?.settings;
  if (snapshot) {
    const providerConfig = snapshot.providerConfigId
      ? input.providerConfigs.find((candidate) => candidate.id === snapshot.providerConfigId)
      : undefined;
    const modelId = snapshot.modelId?.trim();
    const modelConfig = modelId && providerConfig
      ? providerConfig.modelConfigs.find((candidate) => candidate.modelId === modelId)
      : undefined;
    const contextWindowTokens = positiveInteger(snapshot.contextWindowTokens);
    const compressionTrigger = isAutomaticCompression(
      snapshot.compressionMethodKind,
      snapshot.compressionTrigger
    ) ? snapshot.compressionTrigger : undefined;
    return {
      message: latest.message,
      totalTokens: latest.totalTokens,
      invocation,
      ...(providerConfig ? { providerConfig } : {}),
      ...(modelId ? { modelId } : {}),
      ...(modelConfig ? { modelConfig } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(compressionTrigger ? { compressionTrigger } : {}),
      settingsSource: 'invocation'
    };
  }

  const fallback = providerAndModelForMessage(latest.message, input.providerConfigs);
  if (!fallback) {
    return {
      message: latest.message,
      totalTokens: latest.totalTokens,
      ...(invocation ? { invocation } : {}),
      settingsSource: 'unavailable'
    };
  }

  const modelConfig = fallback.provider.modelConfigs.find((candidate) => candidate.modelId === fallback.modelId);
  const contextWindowTokens = positiveInteger(modelConfig?.contextWindowTokens ?? fallback.provider.contextWindowTokens);
  const compressionConfig = compressionConfigForProvider(
    fallback.provider.id,
    fallback.modelId,
    input.compressionSettings,
    input.compressionConfigs
  );
  const compressionTrigger = compressionConfig && isAutomaticCompression(compressionConfig.kind, compressionConfig.trigger)
    ? compressionConfig.trigger
    : undefined;
  return {
    message: latest.message,
    totalTokens: latest.totalTokens,
    ...(invocation ? { invocation } : {}),
    providerConfig: fallback.provider,
    modelId: fallback.modelId,
    ...(modelConfig ? { modelConfig } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(compressionTrigger ? { compressionTrigger } : {}),
    settingsSource: 'message_model'
  };
}

export function latestActualModelUsage(
  messages: readonly MessageRecord[]
): { message: MessageRecord; totalTokens: number } | undefined {
  const sorted = [...messages].sort((left, right) =>
    left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  );
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const message = sorted[index];
    if (message.role !== 'model' || !message.usageMetadata) continue;
    const totalTokens = actualUsageTotal(message.usageMetadata);
    if (totalTokens === undefined) continue;
    return { message, totalTokens };
  }
  return undefined;
}

function actualUsageTotal(usage: LlmUsageMetadataRecord): number | undefined {
  if (usage.estimated === true || usage.tokenEstimator === 'tokenx') return undefined;
  const explicit = usageNumber(usage, TOTAL_TOKEN_KEYS);
  if (explicit !== undefined) return explicit;
  const input = usageNumber(usage, INPUT_TOKEN_KEYS);
  const output = usageNumber(usage, OUTPUT_TOKEN_KEYS);
  const reasoning = usageNumber(usage, REASONING_TOKEN_KEYS);
  const values = [input, output, reasoning].filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? total : undefined;
}

function usageNumber(usage: LlmUsageMetadataRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = positiveInteger(usage[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function invocationForMessage(
  messageId: string,
  links: readonly MessageLlmInvocationLinkRecord[],
  invocations: readonly LlmInvocationRecord[]
): LlmInvocationRecord | undefined {
  const link = [...links]
    .filter((candidate) => candidate.messageId === messageId)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
  return link ? invocations.find((candidate) => candidate.id === link.invocationId) : undefined;
}

function providerAndModelForMessage(
  message: MessageRecord,
  providers: readonly LlmProviderConfigRecord[]
): { provider: LlmProviderConfigRecord; modelId: string } | undefined {
  const label = message.model?.trim();
  if (!label) return undefined;
  const matches = providers.flatMap((provider) => provider.models
    .filter((model) => model.id.trim() === label || model.name.trim() === label)
    .map((model) => ({ provider, modelId: model.id.trim() }))
  );
  if (matches.length === 1) return matches[0];
  return undefined;
}

function compressionConfigForProvider(
  providerConfigId: string,
  modelId: string,
  settings: LlmCompressionSettingsRecord,
  configs: readonly LlmCompressionConfigRecord[]
): LlmCompressionConfigRecord | undefined {
  const modelBinding = settings.modelBindings.find((candidate) =>
    candidate.providerConfigId === providerConfigId && candidate.modelId === modelId
  );
  const providerBinding = settings.providerBindings.find((candidate) => candidate.providerConfigId === providerConfigId);
  const configId = modelBinding?.compressionConfigId ?? providerBinding?.compressionConfigId ?? settings.defaultConfigId;
  return configs.find((candidate) => candidate.id === configId) ?? configs[0];
}

function isAutomaticCompression(
  methodKind: LlmCompressionMethodKind | undefined,
  trigger: LlmCompressionConfigRecord['trigger'] | undefined
): boolean {
  return !!trigger
    && trigger.mode === 'token_threshold'
    && methodKind !== undefined
    && methodKind !== 'disabled'
    && methodKind !== 'manual_summary';
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
