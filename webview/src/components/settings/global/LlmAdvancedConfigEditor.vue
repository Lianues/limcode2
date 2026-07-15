<script setup lang="ts">
import { computed } from 'vue';
import {
  DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
  DEFAULT_LLM_RETRY_ON_ERROR,
  defaultLlmPromptCacheModeForProvider,
  defaultLlmPromptCacheTtlForProvider,
  isPromptCacheSupportedProvider,
  type LlmGenerationConfigRecord,
  type LlmProviderConfigRecord,
  type LlmPromptCacheConfigRecord,
  type LlmPromptCacheMode,
  type LlmPromptCacheTtl,
  type LlmProviderHeadersRecord,
  type LlmRequestBodyRecord,
  type LlmToolCallFormat
} from '@shared/protocol';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import SettingsDropdown, { type SettingsDropdownOption } from './SettingsDropdown.vue';
import LlmHeadersSettings from './parameters/LlmHeadersSettings.vue';
import LlmParameterSettings from './parameters/LlmParameterSettings.vue';

const TOKEN_STEP = 1_000;

type AdvancedConfigPatch = Partial<Pick<
  LlmProviderConfigRecord,
  'toolCallFormat' | 'stream' | 'retryOnError' | 'retryMaxAttempts' | 'enableMultimodalTools'
>>;

const props = defineProps<{
  config: LlmProviderConfigRecord;
}>();

const emit = defineEmits<{
  (event: 'update-field', patch: AdvancedConfigPatch): void;
  (event: 'update-context-window-tokens', value: number | undefined): void;
  (event: 'update-generation-config', value: LlmGenerationConfigRecord | undefined): void;
  (event: 'update-request-body', value: LlmRequestBodyRecord | undefined): void;
  (event: 'update-prompt-cache', value: LlmPromptCacheConfigRecord | undefined): void;
  (event: 'update-headers', value: LlmProviderHeadersRecord | undefined): void;
}>();

const toolCallFormatOptions: SettingsDropdownOption[] = [
  { value: 'function-call', label: 'Function Call' }
];
const promptCacheSupported = computed(() => isPromptCacheSupportedProvider(props.config.provider));
const promptCache = computed<LlmPromptCacheConfigRecord>(() => props.config.promptCache ?? {
  enabled: true,
  mode: defaultLlmPromptCacheModeForProvider(props.config.provider),
  ttl: defaultLlmPromptCacheTtlForProvider(props.config.provider)
});
const promptCacheModeOptions: SettingsDropdownOption[] = [
  {
    value: 'key',
    label: '缓存 Key',
    description: '仅发送按渠道、模型和对话自动生成的 prompt_cache_key；兼容不支持显式断点的模型。'
  },
  {
    value: 'explicit',
    label: '显式断点',
    description: '发送 prompt_cache_options，并在聊天记录末尾写入 prompt_cache_breakpoint；需模型支持。'
  }
];
const promptCacheDescription = computed(() => {
  if (props.config.provider === 'openai-responses') {
    return promptCache.value.mode === 'explicit'
      ? '显式断点模式会发送 prompt_cache_options，并在聊天记录末尾添加断点；部分模型或兼容渠道不支持该参数。'
      : '缓存 Key 模式会为同一渠道、模型和对话自动生成稳定的 prompt_cache_key；不发送显式断点或缓存时间参数。';
  }
  if (props.config.provider === 'claude') {
    return 'Claude 会在系统提示词、工具定义结束和聊天记录末尾写入缓存断点，并支持缓存时间档位。';
  }
  return '当前渠道暂未接入 Prompt Cache。';
});
const promptCacheTtlOptions = computed<SettingsDropdownOption[]>(() => {
  if (props.config.provider === 'openai-responses') {
    return [{ value: '30m', label: '30 分钟', description: 'OpenAI Responses 目前仅支持 30m。' }];
  }
  if (props.config.provider === 'claude') {
    return [
      { value: '1h', label: '1 小时', description: 'Anthropic 最长档位，写入成本更高但命中窗口更长。' },
      { value: '5m', label: '5 分钟', description: 'Anthropic 默认档位。' }
    ];
  }
  return [{ value: defaultLlmPromptCacheTtlForProvider(props.config.provider), label: '最长档位', description: '当前渠道暂未接入 Prompt Cache 断点。' }];
});

function numericInputValue(event: Event): number | undefined {
  const value = (event.target as HTMLInputElement).value.trim();
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function alignTokenCountToK(value: number): number {
  return Math.max(TOKEN_STEP, Math.round(value / TOKEN_STEP) * TOKEN_STEP);
}

function normalizeRetryMaxAttempts(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LLM_RETRY_MAX_ATTEMPTS;
  const attempts = Math.floor(number);
  return attempts < -1 ? -1 : attempts;
}

function updateContextWindowTokens(event: Event): void {
  const value = numericInputValue(event);
  emit('update-context-window-tokens', value === undefined ? undefined : alignTokenCountToK(value));
}

function updateRetryMaxAttempts(event: Event): void {
  emit('update-field', { retryMaxAttempts: normalizeRetryMaxAttempts(numericInputValue(event)) });
}

function updateToolCallFormat(value: string): void {
  emit('update-field', { toolCallFormat: value as LlmToolCallFormat });
}

function updatePromptCacheEnabled(enabled: boolean): void {
  emit('update-prompt-cache', {
    ...promptCache.value,
    enabled,
    mode: normalizePromptCacheMode(promptCache.value.mode),
    ttl: normalizePromptCacheTtl(promptCache.value.ttl)
  });
}

function updatePromptCacheMode(value: string): void {
  emit('update-prompt-cache', {
    ...promptCache.value,
    mode: normalizePromptCacheMode(value),
    ttl: normalizePromptCacheTtl(promptCache.value.ttl)
  });
}

function updatePromptCacheTtl(value: string): void {
  emit('update-prompt-cache', {
    ...promptCache.value,
    ttl: normalizePromptCacheTtl(value)
  });
}

function normalizePromptCacheMode(value: string | undefined): LlmPromptCacheMode {
  if (props.config.provider === 'openai-responses' && value === 'explicit') return 'explicit';
  return defaultLlmPromptCacheModeForProvider(props.config.provider);
}

function normalizePromptCacheTtl(value: string | undefined): LlmPromptCacheTtl {
  if (props.config.provider === 'openai-responses') return '30m';
  if (props.config.provider === 'claude') return value === '5m' || value === '1h' ? value : '1h';
  return defaultLlmPromptCacheTtlForProvider(props.config.provider);
}
</script>

<template>
  <div class="global-settings-grid advanced-config-editor">
    <label class="global-settings-field">
      <span>工具调用格式</span>
      <SettingsDropdown
        :model-value="config.toolCallFormat"
        :options="toolCallFormatOptions"
        title="选择工具调用格式"
        @update:model-value="updateToolCallFormat"
      />
    </label>

    <label class="global-settings-field context-window-field">
      <span>上下文窗口 token 数</span>
      <input
        class="token-number-input"
        :value="config.contextWindowTokens ?? ''"
        type="number"
        min="1000"
        :step="TOKEN_STEP"
        placeholder="例如 200000"
        @change="updateContextWindowTokens"
      />
    </label>

    <div class="global-settings-field stream-field">
      <span>流式生成</span>
      <div class="stream-checkbox-row">
        <LcCheckbox
          :model-value="config.stream !== false"
          size="sm"
          aria-label="启用流式生成"
          @update:model-value="emit('update-field', { stream: $event })"
        >
          <span class="stream-checkbox-enable">启用</span>
        </LcCheckbox>
      </div>
      <span class="stream-checkbox-text">启用流式生成。普通回复和上下文压缩会复用此配置。</span>
    </div>

    <div class="global-settings-field stream-field">
      <span>多模态工具</span>
      <div class="stream-checkbox-row">
        <LcCheckbox
          :model-value="config.enableMultimodalTools !== false"
          size="sm"
          aria-label="启用多模态工具"
          @update:model-value="emit('update-field', { enableMultimodalTools: $event })"
        >
          <span class="stream-checkbox-enable">启用</span>
        </LcCheckbox>
      </div>
      <span class="stream-checkbox-text">启用后 read 可返回图片、PDF 等附件内容；关闭后 read 只读取文本。</span>
    </div>

    <div class="global-settings-field stream-field prompt-cache-field">
      <span>Prompt Cache</span>
      <div class="stream-checkbox-row">
        <LcCheckbox
          :model-value="promptCache.enabled && promptCacheSupported"
          :disabled="!promptCacheSupported"
          size="sm"
          aria-label="启用 Prompt Cache"
          @update:model-value="updatePromptCacheEnabled"
        >
          <span class="stream-checkbox-enable">启用 Prompt Cache</span>
        </LcCheckbox>
      </div>
      <span class="stream-checkbox-text">{{ promptCacheDescription }}</span>
    </div>

    <label v-if="config.provider === 'openai-responses'" class="global-settings-field prompt-cache-mode-field">
      <span>缓存模式</span>
      <SettingsDropdown
        :model-value="promptCache.mode"
        :options="promptCacheModeOptions"
        :disabled="!promptCacheSupported || !promptCache.enabled"
        title="选择 OpenAI Responses Prompt Cache 模式"
        @update:model-value="updatePromptCacheMode"
      />
    </label>

    <label v-if="config.provider === 'claude'" class="global-settings-field prompt-cache-ttl-field">
      <span>缓存时间</span>
      <SettingsDropdown
        :model-value="promptCache.ttl"
        :options="promptCacheTtlOptions"
        :disabled="!promptCacheSupported || !promptCache.enabled"
        title="选择 Prompt Cache 时间档位"
        @update:model-value="updatePromptCacheTtl"
      />
    </label>

    <div class="global-settings-field stream-field retry-field">
      <span>报错自动重试</span>
      <div class="stream-checkbox-row">
        <LcCheckbox
          :model-value="config.retryOnError ?? DEFAULT_LLM_RETRY_ON_ERROR"
          size="sm"
          aria-label="启用报错自动重试"
          @update:model-value="emit('update-field', { retryOnError: $event })"
        >
          <span class="stream-checkbox-enable">启用</span>
        </LcCheckbox>
      </div>
      <span class="stream-checkbox-text">请求报错时自动重试。重试次数不包含原始请求；设置为 -1 表示无限重试。</span>
    </div>

    <label class="global-settings-field retry-attempts-field">
      <span>最大重试次数</span>
      <input
        class="token-number-input"
        :value="config.retryMaxAttempts ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS"
        type="number"
        min="-1"
        step="1"
        placeholder="3"
        @change="updateRetryMaxAttempts"
      />
    </label>

    <LlmParameterSettings
      class="global-settings-field-wide"
      :config="config"
      @update-generation-config="emit('update-generation-config', $event)"
      @update-request-body="emit('update-request-body', $event)"
    />

    <LlmHeadersSettings
      class="global-settings-field-wide"
      :model-value="config.headers ?? {}"
      @update:model-value="emit('update-headers', $event)"
    />
  </div>
</template>

<style scoped>
.advanced-config-editor {
  margin: 0;
}

.stream-field {
  justify-content: start;
}

.stream-checkbox-row {
  min-height: 20px;
  display: flex;
  align-items: center;
}

.stream-checkbox-row :deep(.lc-checkbox-control) {
  align-items: center;
}

.stream-checkbox-row :deep(.lc-checkbox-box) {
  flex: 0 0 auto;
}

.stream-checkbox-enable {
  color: var(--vscode-foreground);
  font-size: var(--font-size-xs);
  line-height: 1.2;
}

.stream-checkbox-text {
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
</style>
