import type { LlmInvocationSettingsSnapshotRecord, LlmUsageMetadataRecord } from '../../../../shared/protocol';

/** unified-llm-provider 已将各 provider 的 usage 归一到 Gemini-like 字段。 */
export function observedUsageTokenCount(usage: LlmUsageMetadataRecord): number | undefined {
  const total = finitePositiveInteger(usage.totalTokenCount);
  if (total !== undefined) return total;

  const prompt = finitePositiveInteger(usage.promptTokenCount) ?? 0;
  const candidates = finitePositiveInteger(usage.candidatesTokenCount) ?? 0;
  const thoughts = finitePositiveInteger(usage.thoughtsTokenCount) ?? 0;
  const sum = prompt + candidates + thoughts;
  return sum > 0 ? sum : undefined;
}

export function compressionThresholdTokens(settings: LlmInvocationSettingsSnapshotRecord): number | undefined {
  const trigger = settings.compressionTrigger;
  if (!trigger) return undefined;

  const contextWindowTokens = finitePositiveInteger(settings.contextWindowTokens);
  const configuredTokens = finitePositiveInteger(trigger.thresholdTokens);
  if (configuredTokens !== undefined) return configuredTokens;

  const thresholdPercent = finitePercent(trigger.thresholdPercent);
  return contextWindowTokens !== undefined && thresholdPercent !== undefined
    ? Math.floor(contextWindowTokens * thresholdPercent / 100)
    : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function finitePercent(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.min(100, Math.max(1, number));
}
