<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import CodeBlockViewer from '../CodeBlockViewer.vue';
import StreamingIndicatorTail from '../StreamingIndicatorTail.vue';
import { useSmoothStreamingText } from '../useSmoothStreamingText';
import { renderMarkdownParts, type MarkdownRenderedPart } from '../markdown/markdownRenderer';

const props = withDefaults(
  defineProps<{
    text: string;
    streaming?: boolean;
    streamingPhase?: 'waiting' | 'thinking' | 'writing';
    markdown?: boolean;
  }>(),
  { streaming: false, streamingPhase: 'writing', markdown: false }
);

const globalSettings = useGlobalSettingsStore();

const tailText = computed(() => {
  switch (props.streamingPhase) {
    case 'waiting': return globalSettings.appearance.streamingTextWaiting;
    case 'thinking': return globalSettings.appearance.streamingTextThinking;
    case 'writing': return globalSettings.appearance.streamingTextWriting;
  }
});

const { displayedText, replacing: replaceAnimating } = useSmoothStreamingText(
  () => props.text,
  () => props.streaming,
  { animateReplace: true }
);
const renderedParts = shallowRef<MarkdownRenderedPart[]>([]);
// 保留流式 Markdown 实时渲染体验。当前 Trace 的主瓶颈在 postMessage 后的响应式扇出、timeline 重建和思考折叠内容 DOM 更新，
// 不是 markdown-it 本身；若后续长代码块仍掉帧，再单独对 Markdown 做节流/增量优化。
const markdownReady = computed(() => props.markdown);

let renderVersion = 0;
let frameId: number | undefined;
let scheduled = false;
let disposed = false;

watch(
  () => [displayedText.value, props.streaming, props.markdown] as const,
  () => scheduleMarkdownRender(),
  { immediate: true }
);

onBeforeUnmount(() => {
  disposed = true;
  clearScheduledRender();
});

function scheduleMarkdownRender(): void {
  renderVersion += 1;

  if (!markdownReady.value) {
    clearScheduledRender();
    renderedParts.value = [];
    return;
  }

  if (scheduled) return;

  scheduled = true;
  frameId = window.requestAnimationFrame(() => {
    frameId = undefined;
    scheduled = false;
    void renderCurrentMarkdown(renderVersion);
  });
}

async function renderCurrentMarkdown(version: number): Promise<void> {
  const source = displayedText.value;
  const streaming = props.streaming;

  try {
    const parts = await renderMarkdownParts(source, { streaming });
    if (disposed) return;

    if (version === renderVersion) {
      renderedParts.value = parts;
      return;
    }

    scheduleMarkdownRender();
  } catch (error) {
    console.warn('[LimCode] Failed to render markdown.', error);
    if (version === renderVersion) renderedParts.value = [];
  }
}

function markdownPartKey(part: MarkdownRenderedPart, index: number): string {
  const content = part.kind === 'html' ? part.html : `${part.language}\n${part.code}`;
  return `${part.kind}-${index}-${content.length}`;
}

function clearScheduledRender(): void {
  scheduled = false;

  if (frameId !== undefined) {
    window.cancelAnimationFrame(frameId);
    frameId = undefined;
  }
}
</script>

<template>
  <div v-if="markdownReady" class="rc-markdown-shell" :class="{ streaming, replacing: replaceAnimating }">
    <template v-if="renderedParts.length">
      <template v-for="(part, index) in renderedParts" :key="markdownPartKey(part, index)">
        <div v-if="part.kind === 'html'" class="rc-markdown" v-html="part.html"></div>
        <CodeBlockViewer v-else class="rc-code-block" :code="part.code" :language="part.language" :info="part.info" />
      </template>
    </template>
    <pre v-else class="rc-text">{{ displayedText }}</pre>
    <StreamingIndicatorTail v-if="streaming" :text="tailText" :variant="streamingPhase" />
  </div>
  <pre v-else class="rc-text" :class="{ replacing: replaceAnimating }">{{ displayedText }}<StreamingIndicatorTail v-if="streaming" :text="tailText" :variant="streamingPhase" /></pre>
</template>

<style scoped>
.rc-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

.rc-text,
.rc-markdown,
.rc-code-block {
  transition: opacity var(--lc-content-replace-duration) ease-out, transform var(--lc-content-replace-duration) ease-out;
}

.rc-text.replacing,
.rc-markdown-shell.replacing .rc-text,
.rc-markdown-shell.replacing .rc-markdown,
.rc-markdown-shell.replacing .rc-code-block {
  opacity: 0;
  transform: translateY(-3px);
}

.rc-markdown-shell {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.rc-markdown {
  min-width: 0;
}

.rc-markdown:not(:last-child) {
  margin-bottom: var(--space-2);
}

.rc-code-block:last-child {
  margin-bottom: 0;
}

.rc-markdown :deep(p),
.rc-markdown :deep(ul),
.rc-markdown :deep(ol),
.rc-markdown :deep(pre),
.rc-markdown :deep(blockquote),
.rc-markdown :deep(table) {
  margin-top: 0;
  margin-bottom: var(--space-2);
}

.rc-markdown :deep(:last-child) {
  margin-bottom: 0;
}

.rc-markdown :deep(ul),
.rc-markdown :deep(ol) {
  padding-left: var(--space-5);
}

.rc-markdown :deep(li + li) {
  margin-top: 2px;
}

.rc-markdown :deep(blockquote) {
  margin-left: 0;
  margin-right: 0;
  padding: 2px 0 2px var(--space-3);
  border-left: 3px solid color-mix(in srgb, var(--vscode-descriptionForeground) 58%, transparent);
  color: var(--vscode-descriptionForeground);
  text-align: left;
}

.rc-markdown :deep(blockquote p) {
  text-align: left;
}

.rc-markdown :deep(pre) {
  max-width: 100%;
  overflow: auto;
  padding: var(--space-2);
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
  border-radius: var(--radius-sm);
  background: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
}

.rc-markdown :deep(code) {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 0.95em;
}

.rc-markdown :deep(pre code) {
  padding: 0;
  border-radius: 0;
  background: transparent;
}

.rc-markdown :deep(a) {
  color: var(--vscode-textLink-foreground);
}

.rc-markdown :deep(table) {
  display: block;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}

.rc-markdown :deep(th),
.rc-markdown :deep(td) {
  padding: 4px 7px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
}

.rc-markdown :deep(img) {
  max-width: 100%;
  height: auto;
}
</style>
