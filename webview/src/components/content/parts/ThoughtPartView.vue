<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconBulb } from '@tabler/icons-vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import StreamingIndicatorTail from '../StreamingIndicatorTail.vue';
import { useSmoothStreamingText } from '../useSmoothStreamingText';
import CollapsibleContentBlock from '../CollapsibleContentBlock.vue';

const props = withDefaults(
  defineProps<{
    text: string;
    streaming?: boolean;
    streamingPhase?: 'waiting' | 'thinking' | 'writing';
    durationMs?: number;
    elapsedMs?: number;
  }>(),
  { streaming: false, streamingPhase: 'thinking' }
);

const globalSettings = useGlobalSettingsStore();
const expanded = ref(false);
const { displayedText } = useSmoothStreamingText(
  () => props.text,
  () => props.streaming
);
const preview = computed(() => lastNonEmptyLine(displayedText.value) || '正在思考...');
const tailText = computed(() => {
  if (props.streaming) return `思考了 ${formatThoughtDuration(props.elapsedMs ?? 0)}`;
  return props.durationMs !== undefined ? `已思考 ${formatThoughtDuration(props.durationMs)}` : '思考完成';
});

function lastNonEmptyLine(text: string): string {
  let end = text.length;
  while (end > 0 && /\s/.test(text.charAt(end - 1))) end -= 1;
  if (end <= 0) return '';

  let lineEnd = end;
  while (lineEnd > 0) {
    let lineStart = lineEnd;
    while (lineStart > 0 && text.charAt(lineStart - 1) !== '\n' && text.charAt(lineStart - 1) !== '\r') lineStart -= 1;
    const line = text.slice(lineStart, lineEnd).trim();
    if (line) return line;
    lineEnd = lineStart;
    while (lineEnd > 0 && (text.charAt(lineEnd - 1) === '\n' || text.charAt(lineEnd - 1) === '\r')) lineEnd -= 1;
  }
  return '';
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
  <CollapsibleContentBlock
    v-model:expanded="expanded"
    class="thought-panel"
    :class="{ 'is-streaming': streaming }"
    kind="input"
    :icon-active="streaming"
    :aria-label="expanded ? '收起思考内容' : '展开思考内容'"
  >
    <template #icon>
      <IconBulb stroke="2" aria-hidden="true" />
    </template>
    <template #summary>
      <span class="thought-preview">{{ preview }}</span>
    </template>
    <template #trail>
      <span class="thought-tail">{{ tailText }}</span>
    </template>

    <!-- 折叠时不要渲染完整思考正文。否则流式阶段每帧都会更新隐藏 pre 的完整 text node，长思考会明显掉帧。 -->
    <div v-if="expanded" class="thought-content">
      <pre>{{ displayedText }}</pre>
    </div>
  </CollapsibleContentBlock>
  <div v-if="streaming" class="thought-streaming-row"><StreamingIndicatorTail :text="globalSettings.appearance.streamingTextThinking" variant="thinking" /></div>
</template>

<style scoped>
.thought-panel {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  min-width: 0;
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

.thought-content {
  margin: 3px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  color: var(--vscode-descriptionForeground);
  background: var(--lc-content-input-background);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  font: inherit;
  font-style: italic;
  line-height: 1.5;
}

.thought-content > pre {
  margin: 0;
  max-width: 100%;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  font: inherit;
}

.thought-streaming-row {
  margin-top: 4px;
  font-style: italic;
}
</style>
