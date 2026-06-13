<script setup lang="ts">
import { computed, useSlots } from 'vue';

const props = withDefaults(defineProps<{
  modelValue?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  presentation?: boolean;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}>(), {
  modelValue: false,
  disabled: false,
  readonly: false,
  presentation: false,
  size: 'md'
});

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'change', value: boolean): void;
}>();

const slots = useSlots();
const checked = computed(() => props.modelValue === true);
const disabledOrReadonly = computed(() => props.disabled || props.readonly);
const hasSlotContent = computed(() => !!slots.default);

function toggle(): void {
  if (props.presentation || disabledOrReadonly.value) return;
  const next = !checked.value;
  emit('update:modelValue', next);
  emit('change', next);
}
</script>

<template>
  <span
    v-if="presentation"
    class="lc-checkbox-box lc-checkbox-visual"
    :class="[`is-${size}`, { 'is-checked': checked, 'is-disabled': disabled }]"
    aria-hidden="true"
  >
    <svg class="lc-checkbox-icon" viewBox="0 0 16 16" focusable="false" aria-hidden="true">
      <path class="lc-checkbox-check" d="M4 8.35 6.75 11 12.2 5" />
    </svg>
  </span>

  <button
    v-else
    type="button"
    class="lc-checkbox-control"
    :class="[`is-${size}`, { 'is-checked': checked, 'is-disabled': disabled, 'is-readonly': readonly, 'has-content': hasSlotContent }]"
    role="checkbox"
    :aria-checked="checked"
    :aria-label="ariaLabel"
    :disabled="disabled"
    @click="toggle"
    @keydown.space.prevent="toggle"
    @keydown.enter.prevent="toggle"
  >
    <span class="lc-checkbox-box" aria-hidden="true">
      <svg class="lc-checkbox-icon" viewBox="0 0 16 16" focusable="false" aria-hidden="true">
        <path class="lc-checkbox-check" d="M4 8.35 6.75 11 12.2 5" />
      </svg>
    </span>
    <span v-if="$slots.default" class="lc-checkbox-content">
      <slot />
    </span>
  </button>
</template>

<style scoped>
.lc-checkbox-control {
  min-width: 0;
  border: 0;
  padding: 0;
  display: inline-grid;
  grid-template-columns: var(--lc-checkbox-size) minmax(0, 1fr);
  gap: var(--space-2);
  align-items: flex-start;
  color: inherit;
  background: transparent;
  text-align: left;
  font: inherit;
  appearance: none;
  -webkit-appearance: none;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.lc-checkbox-control:hover,
.lc-checkbox-control:active {
  color: inherit;
  background: transparent;
}

.lc-checkbox-control:not(.has-content) {
  grid-template-columns: var(--lc-checkbox-size);
  gap: 0;
}

.lc-checkbox-control:not(:disabled):not(.is-readonly) {
  cursor: pointer;
}

.lc-checkbox-control:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 2px;
}

.lc-checkbox-control.is-disabled,
.lc-checkbox-control.is-readonly {
  cursor: default;
}

.lc-checkbox-box {
  width: var(--lc-checkbox-size);
  height: var(--lc-checkbox-size);
  box-sizing: border-box;
  border: 1px solid var(--vscode-descriptionForeground);
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-foreground);
  background: transparent;
  transition:
    border-color 0.14s ease,
    background-color 0.14s ease,
    opacity 0.14s ease;
}

.lc-checkbox-control.is-sm,
.lc-checkbox-box.is-sm {
  --lc-checkbox-size: 14px;
}

.lc-checkbox-control.is-md,
.lc-checkbox-box.is-md {
  --lc-checkbox-size: 16px;
}

.lc-checkbox-control.is-checked .lc-checkbox-box,
.lc-checkbox-box.is-checked {
  border-color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
}

.lc-checkbox-control.is-disabled .lc-checkbox-box,
.lc-checkbox-box.is-disabled {
  opacity: 0.45;
}

.lc-checkbox-icon {
  width: 100%;
  height: 100%;
  display: block;
  fill: none;
}

.lc-checkbox-check {
  stroke: currentColor;
  stroke-width: 2.15;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 14;
  stroke-dashoffset: 14;
  opacity: 0;
  transform: translateY(0.5px) scale(0.92);
  transform-origin: center;
  transition:
    stroke-dashoffset 0.18s ease,
    opacity 0.12s ease,
    transform 0.16s ease;
}

.lc-checkbox-control.is-checked .lc-checkbox-check,
.lc-checkbox-box.is-checked .lc-checkbox-check {
  stroke-dashoffset: 0;
  opacity: 1;
  transform: translateY(0) scale(1);
}

.lc-checkbox-content {
  min-width: 0;
}
</style>
