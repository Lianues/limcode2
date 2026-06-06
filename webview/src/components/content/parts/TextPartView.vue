<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { useSmoothStreamingText } from '../useSmoothStreamingText';
import { renderMarkdown } from '../markdown/markdownRenderer';

const props = withDefaults(
  defineProps<{
    text: string;
    streaming?: boolean;
    markdown?: boolean;
  }>(),
  { streaming: false, markdown: false }
);

const { displayedText, replacing: replaceAnimating } = useSmoothStreamingText(
  () => props.text,
  () => props.streaming,
  { animateReplace: true }
);
const renderedHtml = shallowRef('');
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
    renderedHtml.value = '';
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
    const html = await renderMarkdown(source, { streaming });
    if (disposed) return;

    if (version === renderVersion) {
      renderedHtml.value = html;
      return;
    }

    scheduleMarkdownRender();
  } catch (error) {
    console.warn('[LimCode] Failed to render markdown.', error);
    if (version === renderVersion) renderedHtml.value = '';
  }
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
    <div v-if="renderedHtml" class="rc-markdown" v-html="renderedHtml"></div>
    <pre v-else class="rc-text">{{ displayedText }}</pre>
    <span v-if="streaming" class="rc-cursor">▋</span>
  </div>
  <pre v-else class="rc-text" :class="{ replacing: replaceAnimating }">{{ displayedText }}<span v-if="streaming" class="rc-cursor">▋</span></pre>
</template>

<style scoped>
.rc-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

.rc-text,
.rc-markdown {
  transition: opacity var(--lc-content-replace-duration) ease-out, transform var(--lc-content-replace-duration) ease-out;
}

.rc-text.replacing,
.rc-markdown-shell.replacing .rc-text,
.rc-markdown-shell.replacing .rc-markdown {
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
  padding-left: var(--space-3);
  border-left: 2px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  color: var(--vscode-descriptionForeground);
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

.rc-cursor {
  animation: lc-content-cursor-blink var(--lc-content-cursor-blink-duration) steps(2, start) infinite;
}

.rc-markdown-shell > .rc-cursor {
  display: inline-block;
  margin-left: 1px;
}
</style>
