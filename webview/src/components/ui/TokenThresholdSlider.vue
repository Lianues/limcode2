<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  modelValue?: number;
  maxTokens?: number;
  minTokens?: number;
  stepTokens?: number;
  recommendedTokens?: number;
  disabled?: boolean;
  ariaLabel?: string;
  recommendedLabel?: string;
  labelVariant?: 'plain' | 'tag';
  showTopLabel?: boolean;
  showBottomLabel?: boolean;
  showRecommendedTag?: boolean;
}>(), {
  modelValue: 0,
  maxTokens: 0,
  minTokens: 1_000,
  stepTokens: 1_000,
  disabled: false,
  ariaLabel: '拖拽调整 token 阈值',
  recommendedLabel: '建议',
  labelVariant: 'plain',
  showTopLabel: true,
  showBottomLabel: true,
  showRecommendedTag: true
});

const emit = defineEmits<{
  (event: 'update:modelValue', value: number): void;
  (event: 'applyRecommended', value: number): void;
}>();

const safeStepTokens = computed(() => normalizePositiveInteger(props.stepTokens) ?? 1_000);
const safeMinTokens = computed(() => normalizePositiveInteger(props.minTokens) ?? safeStepTokens.value);
const rawMaxTokens = computed(() => normalizePositiveInteger(props.maxTokens) ?? 0);
const enabled = computed(() => props.disabled !== true && rawMaxTokens.value > 0);
const rangeMaxTokens = computed(() => enabled.value ? Math.max(safeMinTokens.value, rawMaxTokens.value) : safeMinTokens.value);
const currentTokens = computed(() => enabled.value
  ? clampTokenCount(normalizePositiveInteger(props.modelValue) ?? safeMinTokens.value)
  : safeMinTokens.value
);
const recommendedValue = computed(() => {
  if (!enabled.value) return undefined;
  const value = normalizePositiveInteger(props.recommendedTokens);
  return value === undefined ? undefined : clampTokenCount(value);
});
const currentPercent = computed(() => percentForTokens(currentTokens.value));
const recommendedPercent = computed(() => recommendedValue.value === undefined ? 100 : percentForTokens(recommendedValue.value));
const safeLabelVariant = computed(() => props.labelVariant === 'tag' ? 'tag' : 'plain');
const currentLabelStyle = computed(() => ({ left: `${currentPercent.value}%` }));
const recommendedLabelStyle = computed(() => ({ left: `${recommendedPercent.value}%` }));
const rangeStyle = computed(() => ({
  '--token-threshold-percent': `${currentPercent.value}%`,
  '--token-recommend-start': `${recommendedPercent.value}%`
}));

function normalizePositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function alignTokenCount(value: number): number {
  return Math.max(safeMinTokens.value, Math.round(value / safeStepTokens.value) * safeStepTokens.value);
}

function clampTokenCount(value: number): number {
  return Math.min(rangeMaxTokens.value, alignTokenCount(value));
}

function percentForTokens(tokens: number): number {
  if (rawMaxTokens.value <= 0) return 0;
  return Math.min(100, Math.max(0, (tokens / rawMaxTokens.value) * 100));
}

function formatTokenLabel(value: number | undefined): string {
  const tokens = normalizePositiveInteger(value);
  if (tokens === undefined) return '未设置';
  const kilo = tokens / 1_000;
  if (kilo >= 1) return `${Number.isInteger(kilo) ? kilo.toFixed(0) : kilo.toFixed(1)}k`;
  return `${tokens}`;
}

function formatPercentLabel(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '0%';
  const percent = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${percent}%`;
}

function updateFromRange(event: Event): void {
  if (!enabled.value) return;
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  const nextValue = clampTokenCount(value);
  if (nextValue !== currentTokens.value) emit('update:modelValue', nextValue);
}

function applyRecommended(): void {
  if (recommendedValue.value === undefined) return;
  if (recommendedValue.value === currentTokens.value) return;
  emit('update:modelValue', recommendedValue.value);
  emit('applyRecommended', recommendedValue.value);
}
</script>

<template>
  <div
    class="token-threshold-slider"
    :class="[
      `label-${safeLabelVariant}`,
      {
        disabled: !enabled,
        'show-top-label': showTopLabel,
        'show-bottom-label': showBottomLabel,
        'show-recommended-tag': showRecommendedTag && recommendedValue !== undefined
      }
    ]"
  >
    <div
      v-if="showTopLabel"
      class="token-threshold-slider-label token-threshold-slider-label-top"
      :style="currentLabelStyle"
    >
      {{ formatTokenLabel(currentTokens) }}
    </div>
    <input
      class="token-threshold-range-input"
      type="range"
      :min="safeMinTokens"
      :max="rangeMaxTokens"
      :step="safeStepTokens"
      :value="currentTokens"
      :disabled="!enabled"
      :style="rangeStyle"
      :aria-label="ariaLabel"
      @input="updateFromRange"
    />
    <button
      v-if="showRecommendedTag && recommendedValue !== undefined"
      type="button"
      class="token-threshold-recommend-tag"
      :style="recommendedLabelStyle"
      aria-label="点击应用建议阈值"
      @click="applyRecommended"
    >{{ recommendedLabel }} {{ formatTokenLabel(recommendedValue) }}</button>
    <div
      v-if="showBottomLabel"
      class="token-threshold-slider-label token-threshold-slider-label-bottom"
      :style="currentLabelStyle"
    >
      {{ formatPercentLabel(currentPercent) }}
    </div>
  </div>
</template>

<style scoped>
.token-threshold-slider {
  position: relative;
  width: 100%;
  min-height: 76px;
  padding: 23px 2px 26px;
}

.token-threshold-slider:not(.show-top-label) {
  min-height: 53px;
  padding-top: 0;
}

.token-threshold-slider:not(.show-bottom-label) {
  min-height: 50px;
  padding-bottom: 0;
}

.token-threshold-slider:not(.show-top-label):not(.show-bottom-label).show-recommended-tag {
  min-height: 44px;
  padding-top: 0;
  padding-bottom: 26px;
}

.token-threshold-slider:not(.show-top-label):not(.show-bottom-label):not(.show-recommended-tag) {
  min-height: 16px;
}

.token-threshold-slider.disabled {
  opacity: 0.55;
}

.token-threshold-range-input {
  --token-threshold-percent: 80%;
  --token-recommend-start: 84%;
  width: 100%;
  height: 12px;
  margin: 0;
  border-radius: 999px;
  appearance: none;
  background:
    linear-gradient(to right, transparent 0 var(--token-recommend-start), color-mix(in srgb, var(--vscode-descriptionForeground) 20%, transparent) var(--token-recommend-start) 100%),
    linear-gradient(
      to right,
      color-mix(in srgb, var(--vscode-foreground) 42%, transparent) 0 var(--token-threshold-percent),
      color-mix(in srgb, var(--vscode-panel-border) 74%, transparent) var(--token-threshold-percent) 100%
    );
  cursor: pointer;
}

.token-threshold-range-input:disabled {
  cursor: not-allowed;
}

.token-threshold-range-input:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
  outline-offset: 4px;
}

.token-threshold-range-input::-webkit-slider-thumb {
  width: 14px;
  height: 14px;
  border: 1px solid var(--vscode-foreground);
  border-radius: 50%;
  appearance: none;
  background: var(--vscode-editor-background);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
}

.token-threshold-range-input::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: 1px solid var(--vscode-foreground);
  border-radius: 50%;
  background: var(--vscode-editor-background);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
}

.token-threshold-slider-label,
.token-threshold-recommend-tag {
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: var(--font-size-xs);
  line-height: 1;
}

.token-threshold-slider-label {
  pointer-events: none;
  color: var(--vscode-descriptionForeground);
}

.token-threshold-slider-label-top {
  top: 0;
}

.token-threshold-slider-label-bottom {
  bottom: 0;
}

.token-threshold-slider.label-tag .token-threshold-slider-label {
  border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 24%, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: 2px 5px;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  line-height: 1;
}

.token-threshold-recommend-tag {
  bottom: 14px;
  border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 28%, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  padding: 2px 5px;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
}

.token-threshold-recommend-tag:hover,
.token-threshold-recommend-tag:focus-visible {
  color: var(--vscode-foreground);
  border-color: color-mix(in srgb, var(--vscode-foreground) 36%, var(--vscode-panel-border));
  background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-foreground) 20%);
  outline: none;
}
</style>
