<script setup lang="ts">
import { computed } from 'vue';
import {
  DEFAULT_LLM_COMPRESSION_RESERVE_TOKENS,
  type LlmCompressionConfigRecord,
  type LlmCompressionMethodKind,
  type LlmProviderConfigRecord,
  type LlmProviderKind
} from '@shared/protocol';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import TokenThresholdSlider from '@webview/components/ui/TokenThresholdSlider.vue';
import SettingsDropdown, { type SettingsDropdownOption } from './SettingsDropdown.vue';

type SelectableCompressionMethodKind = 'openai_responses_compact' | 'llm_summary' | 'segmented_summary' | 'deterministic_summary';

const TOKEN_STEP = 1_000;

const props = defineProps<{
  config?: LlmCompressionConfigRecord;
  currentProviderConfig?: LlmProviderConfigRecord;
  providerConfigs: LlmProviderConfigRecord[];
  contextWindowTokens: number;
}>();

const emit = defineEmits<{
  (event: 'update-provider-config-id', value: string): void;
  (event: 'update-method-kind', value: SelectableCompressionMethodKind): void;
  (event: 'update-trigger', value: Partial<LlmCompressionConfigRecord['trigger']>): void;
}>();

const providerOptions: SettingsDropdownOption[] = [
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'deepseek', label: 'DeepSeek' }
];

const providerConfigId = computed({
  get: () => props.config?.openaiResponsesCompact?.providerConfigId
    ?? props.config?.llmSummary?.providerConfigId
    ?? '__current__',
  set: (value: string) => emit('update-provider-config-id', value === '__current__' ? '' : value)
});

const providerConfig = computed(() => {
  const id = providerConfigId.value;
  return id === '__current__'
    ? props.currentProviderConfig
    : props.providerConfigs.find((config) => config.id === id) ?? props.currentProviderConfig;
});

const providerConfigOptions = computed<SettingsDropdownOption[]>(() => [
  {
    value: '__current__',
    label: '跟随当前渠道',
    description: props.currentProviderConfig
      ? `${props.currentProviderConfig.name} · ${providerLabel(props.currentProviderConfig.provider)}`
      : '使用当前模型渠道'
  },
  ...props.providerConfigs.map((config) => ({
    value: config.id,
    label: config.name,
    description: config.model ? `${providerLabel(config.provider)} · ${config.model}` : providerLabel(config.provider)
  }))
]);

const activeMethodKind = computed<SelectableCompressionMethodKind>(() => {
  const kind = props.config?.kind ?? 'segmented_summary';
  if (kind === 'disabled' || kind === 'manual_summary') return 'llm_summary';
  return kind;
});

const methodOptions = computed<SettingsDropdownOption[]>(() => {
  const base: SettingsDropdownOption[] = [
    { value: 'segmented_summary', label: '分段总结拼接' },
    { value: 'llm_summary', label: 'LLM 总结' },
    { value: 'deterministic_summary', label: '确定性摘要' }
  ];
  if (providerConfig.value?.provider === 'openai-responses' || props.config?.kind === 'openai_responses_compact') {
    base.splice(2, 0, { value: 'openai_responses_compact', label: 'OpenAI 原生压缩' });
  }
  return base;
});

const trigger = computed(() => props.config?.trigger);
const compressionAutoEnabled = computed(() => (trigger.value?.mode ?? 'token_threshold') === 'token_threshold');
const compressionReserveTokens = computed(() => normalizeTokenCount(trigger.value?.reserveLatestUserMessageTokens) ?? DEFAULT_LLM_COMPRESSION_RESERVE_TOKENS);
const configuredThresholdPercent = computed(() => clampPercent(trigger.value?.thresholdPercent ?? 80));
const compressionThresholdTokens = computed(() => {
  const contextWindow = props.contextWindowTokens;
  const tokenValue = normalizeTokenCount(trigger.value?.thresholdTokens);
  if (tokenValue !== undefined) return contextWindow > 0 ? Math.min(tokenValue, contextWindow) : tokenValue;
  if (contextWindow <= 0) return 0;
  return clampTokenToContext((contextWindow * configuredThresholdPercent.value) / 100, contextWindow);
});
const compressionThresholdPercent = computed(() => {
  const contextWindow = props.contextWindowTokens;
  const thresholdTokens = compressionThresholdTokens.value;
  if (contextWindow > 0 && thresholdTokens > 0) return clampPercent((thresholdTokens / contextWindow) * 100);
  return configuredThresholdPercent.value;
});
const recommendedThresholdTokens = computed(() => {
  const contextWindow = props.contextWindowTokens;
  if (contextWindow <= 0) return 0;
  return clampTokenToContext(contextWindow - compressionReserveTokens.value, contextWindow);
});
const compressionThresholdInputValue = computed(() => String(compressionThresholdTokens.value || ''));

function providerLabel(provider: LlmProviderKind | undefined): string {
  return providerOptions.find((option) => option.value === provider)?.label ?? '未知渠道';
}

function compressionKindLabel(kind: LlmCompressionMethodKind | undefined): string {
  switch (kind) {
    case 'openai_responses_compact': return 'OpenAI 原生压缩';
    case 'llm_summary': return 'LLM 总结';
    case 'segmented_summary': return '分段总结拼接';
    case 'deterministic_summary': return '确定性摘要';
    case 'manual_summary': return '手动摘要';
    case 'disabled': return '关闭';
    default: return '未知方法';
  }
}

function normalizeTokenCount(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function alignTokenCountToK(value: number): number {
  return Math.max(TOKEN_STEP, Math.round(value / TOKEN_STEP) * TOKEN_STEP);
}

function clampTokenToContext(value: number, contextWindow = props.contextWindowTokens): number {
  const aligned = alignTokenCountToK(value);
  return contextWindow > 0 ? Math.min(contextWindow, aligned) : aligned;
}

function clampPercent(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(100, Math.max(1, number));
}

function percentForTokens(tokens: number, contextWindow = props.contextWindowTokens): number {
  return contextWindow > 0 ? clampPercent((tokens / contextWindow) * 100) : compressionThresholdPercent.value;
}

function formatTokenLabel(value: number | undefined): string {
  const tokens = normalizeTokenCount(value);
  if (tokens === undefined) return '未设置';
  const kilo = tokens / 1_000;
  if (kilo >= 1) return `${Number.isInteger(kilo) ? kilo.toFixed(0) : kilo.toFixed(1)}k`;
  return `${tokens}`;
}

function numericInputValue(event: Event): number | undefined {
  const value = (event.target as HTMLInputElement).value.trim();
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function updateCompressionAutoEnabled(enabled: boolean): void {
  emit('update-trigger', { mode: enabled ? 'token_threshold' : 'manual' });
}

function updateCompressionThresholdTokens(event: Event): void {
  const value = numericInputValue(event);
  if (value === undefined) return;
  updateCompressionThresholdFromTokens(value);
}

function updateCompressionThresholdFromTokens(value: number): void {
  const tokens = clampTokenToContext(value);
  emit('update-trigger', {
    thresholdUnit: 'tokens',
    thresholdTokens: tokens,
    thresholdPercent: percentForTokens(tokens)
  });
}

function updateMethodKind(value: string): void {
  emit('update-method-kind', value as SelectableCompressionMethodKind);
}
</script>

<template>
  <section class="compression-settings" aria-label="上下文压缩">
    <header class="compression-settings-header">
      <div>
        <label>上下文压缩</label>
        <p>当前压缩方法：{{ compressionKindLabel(config?.kind) }}。OpenAI 原生压缩必须使用 OpenAI Responses 渠道。</p>
      </div>
    </header>
    <div class="global-settings-grid compression-settings-grid">
      <label class="global-settings-field">
        <span>压缩使用的模型渠道</span>
        <SettingsDropdown
          v-model="providerConfigId"
          :options="providerConfigOptions"
          title="选择压缩使用的渠道配置"
          searchable
          search-placeholder="筛选渠道..."
        />
      </label>
      <label class="global-settings-field">
        <span>压缩方法</span>
        <SettingsDropdown
          :model-value="activeMethodKind"
          :options="methodOptions"
          title="选择压缩方法"
          @update:model-value="updateMethodKind"
        />
      </label>

      <label class="global-settings-field global-settings-field-wide compression-auto-field">
        <span>自动触发</span>
        <LcCheckbox
          :model-value="compressionAutoEnabled"
          aria-label="启用自动触发上下文压缩"
          @update:model-value="updateCompressionAutoEnabled"
        >
          <span class="compression-auto-text">启用后，当上下文达到阈值时自动准备压缩。默认建议开启。</span>
        </LcCheckbox>
      </label>

      <div v-if="compressionAutoEnabled" class="compression-trigger-panel global-settings-field-wide">
        <div class="compression-trigger-head">
          <div>
            <span class="compression-trigger-title">触发上下文 token 数阈值</span>
            <p>直接填写触发压缩的上下文 token 数；建议至少预留 {{ formatTokenLabel(compressionReserveTokens) }} 窗口给最后一轮用户消息。</p>
          </div>
        </div>

        <div class="compression-threshold-control">
          <label class="global-settings-field compression-threshold-input-field">
            <span>上下文 token 数</span>
            <span class="threshold-input-shell">
              <input
                class="token-number-input"
                :value="compressionThresholdInputValue"
                type="number"
                :min="TOKEN_STEP"
                :max="contextWindowTokens || undefined"
                :step="TOKEN_STEP"
                :disabled="contextWindowTokens <= 0"
                @change="updateCompressionThresholdTokens"
              />
              <span>token</span>
            </span>
          </label>

          <TokenThresholdSlider
            :model-value="compressionThresholdTokens"
            :max-tokens="contextWindowTokens"
            :step-tokens="TOKEN_STEP"
            :recommended-tokens="recommendedThresholdTokens"
            :disabled="contextWindowTokens <= 0"
            aria-label="拖拽调整自动压缩触发阈值"
            @update:model-value="updateCompressionThresholdFromTokens"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.compression-settings {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%);
}

.compression-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.compression-settings-header p {
  margin: 2px 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.compression-settings-grid {
  margin: 0;
}

.compression-auto-text {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.token-number-input[type='number'] {
  appearance: textfield;
  -moz-appearance: textfield;
}

.token-number-input[type='number']::-webkit-outer-spin-button,
.token-number-input[type='number']::-webkit-inner-spin-button {
  margin: 0;
  -webkit-appearance: none;
}

.compression-auto-field {
  padding-top: var(--space-1);
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent);
}

.compression-trigger-panel {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
}

.compression-trigger-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: flex-start;
}

.compression-trigger-title {
  display: block;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.compression-trigger-head p {
  margin: 3px 0 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.compression-threshold-control {
  display: grid;
  grid-template-columns: minmax(130px, 190px) minmax(0, 1fr);
  gap: var(--space-3);
  align-items: center;
}

.compression-threshold-input-field {
  min-width: 0;
}

.threshold-input-shell {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
}

.threshold-input-shell input {
  min-width: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.threshold-input-shell input:focus {
  outline: none;
}

.threshold-input-shell > span {
  padding: 0 var(--space-2);
  font-size: var(--font-size-xs);
}

@media (max-width: 720px) {
  .compression-trigger-head,
  .compression-threshold-control {
    grid-template-columns: 1fr;
  }

  .compression-trigger-head {
    display: grid;
  }
}
</style>
