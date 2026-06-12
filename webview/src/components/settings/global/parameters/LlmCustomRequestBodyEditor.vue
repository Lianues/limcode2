<script setup lang="ts">
import type { LlmRequestBodyJsonValue, LlmRequestBodyRecord } from '@shared/protocol';
import LlmJsonValueEditor from './LlmJsonValueEditor.vue';

const props = withDefaults(
  defineProps<{
    modelValue: LlmRequestBodyRecord;
    level?: number;
  }>(),
  {
    level: 0
  }
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: LlmRequestBodyRecord): void;
}>();

function updateRoot(value: LlmRequestBodyJsonValue): void {
  emit('update:modelValue', isPlainObject(value) ? value : {});
}

function isPlainObject(value: unknown): value is LlmRequestBodyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
</script>

<template>
  <LlmJsonValueEditor
    :model-value="props.modelValue"
    :level="level"
    root-object
    @update:model-value="updateRoot"
  />
</template>
