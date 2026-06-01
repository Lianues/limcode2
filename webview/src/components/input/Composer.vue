<script setup lang="ts">
import { ref } from 'vue';
import RichContentEditor from '@webview/components/content/RichContentEditor.vue';

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    placeholder?: string;
  }>(),
  { disabled: false, placeholder: '' }
);

const emit = defineEmits<{
  (event: 'submit', text: string): void;
}>();

const draft = ref('');

function submit(): void {
  const text = draft.value.trim();
  if (!text || props.disabled) return;
  emit('submit', text);
  draft.value = '';
}
</script>

<template>
  <div class="composer">
    <RichContentEditor
      v-model="draft"
      class="composer-editor"
      :placeholder="placeholder"
      :disabled="disabled"
      :rows="2"
      @submit="submit"
    />
    <button type="button" class="composer-send" :disabled="disabled || !draft.trim()" @click="submit">发送</button>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  gap: var(--space-2);
  align-items: flex-end;
}

.composer-editor {
  flex: 1;
}

.composer-send {
  flex: 0 0 auto;
}
</style>
