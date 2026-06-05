<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconBulb, IconBulbOff, IconChevronRight } from '@tabler/icons-vue';
import { useSmoothStreamingText } from '../useSmoothStreamingText';

const props = withDefaults(
  defineProps<{
    text: string;
    streaming?: boolean;
    durationMs?: number;
  }>(),
  { streaming: false }
);

const expanded = ref(false);
const { displayedText } = useSmoothStreamingText(
  () => props.text,
  () => props.streaming
);
const preview = computed(() => lastNonEmptyLine(displayedText.value) || '正在思考...');
const tailText = computed(() => {
  if (props.streaming) return '思考中';
  return props.durationMs !== undefined ? `已思考 ${formatThoughtDuration(props.durationMs)}` : '思考完成';
});

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}

function lastNonEmptyLine(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line) return line;
  }
  return text.trim();
}

function formatThoughtDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    const digits = seconds < 10 ? 1 : 0;
    return `${seconds.toFixed(digits)}秒`;
  }

  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  if (minutes < 60) {
    return restSeconds > 0 ? `${minutes}分${restSeconds}秒` : `${minutes}分`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}小时${restMinutes}分` : `${hours}小时`;
}
</script>

<template>
  <section class="thought-panel" :class="{ 'is-expanded': expanded, 'is-streaming': streaming }">
    <button
      type="button"
      class="thought-summary"
      :aria-expanded="expanded"
      :aria-label="expanded ? '收起思考内容' : '展开思考内容'"
      @click="toggleExpanded"
    >
      <IconChevronRight class="thought-chevron" :class="{ 'is-expanded': expanded }" stroke="2" aria-hidden="true" />
      <IconBulb v-if="streaming" class="thought-icon is-active" stroke="2" aria-hidden="true" />
      <IconBulbOff v-else class="thought-icon" stroke="2" aria-hidden="true" />
      <span class="thought-preview">{{ preview }}</span>
      <span class="thought-tail">{{ tailText }}</span>
    </button>
    <div class="thought-content-shell" :class="{ 'is-expanded': expanded }" :aria-hidden="!expanded">
      <div class="thought-content-frame">
        <pre class="thought-content">{{ displayedText }}<span v-if="streaming" class="thought-cursor">▋</span></pre>
      </div>
    </div>
  </section>
</template>

<style scoped>
.thought-panel {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.thought-summary {
  width: 100%;
  min-width: 0;
  min-height: 0;
  padding: 4px 7px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  gap: 6px;
  color: inherit;
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  cursor: pointer;
  text-align: left;
}

.thought-summary:hover,
.thought-summary:focus-visible {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}

.thought-summary:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 2px;
}

.thought-chevron,
.thought-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}

.thought-chevron {
  transition: transform 160ms ease;
}

.thought-chevron.is-expanded {
  transform: rotate(90deg);
}

.thought-icon {
  color: var(--vscode-descriptionForeground);
}

.thought-icon.is-active {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.thought-preview {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-style: italic;
}

.thought-tail {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.thought-content-shell {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transform: translateY(-3px);
  transition:
    grid-template-rows 180ms ease,
    opacity 140ms ease,
    transform 140ms ease;
}

.thought-content-shell.is-expanded {
  grid-template-rows: 1fr;
  opacity: 1;
  transform: translateY(0);
}

.thought-content-frame {
  min-height: 0;
  overflow: hidden;
}

.thought-content {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  font: inherit;
  font-style: italic;
  line-height: 1.5;
}

.thought-cursor {
  animation: lc-content-cursor-blink var(--lc-content-cursor-blink-duration) steps(2, start) infinite;
}
</style>
