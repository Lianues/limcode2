<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { renderMarkdown } from '../markdown/markdownRenderer';

const STREAM_RENDER_INTERVAL_MS = 64;
const STREAM_CATCHUP_FRAMES = 14;
const STREAM_MAX_CHARS_PER_FRAME = 32;
const REPLACE_OUT_MS = 90;

const props = withDefaults(
  defineProps<{
    text: string;
    streaming?: boolean;
    markdown?: boolean;
  }>(),
  { streaming: false, markdown: false }
);

const displayedText = shallowRef('');
const renderedHtml = shallowRef('');
const replaceAnimating = ref(false);
const markdownReady = computed(() => props.markdown);

let renderVersion = 0;
let lastRenderTime = 0;
let timeoutId: number | undefined;
let frameId: number | undefined;
let streamFrameId: number | undefined;
let lastStreamFrameTime = 0;
let replaceTimerId: number | undefined;
let replaceFrameId: number | undefined;
let scheduled = false;
let disposed = false;

watch(
  () => [props.text, props.streaming] as const,
  (_next, previous) => syncDisplayedText(previous?.[1] ?? false),
  { immediate: true }
);

watch(
  () => [displayedText.value, props.streaming, props.markdown] as const,
  () => scheduleMarkdownRender(),
  { immediate: true }
);

onBeforeUnmount(() => {
  disposed = true;
  clearScheduledRender();
  clearStreamFrame();
  clearReplaceTransition();
});

function syncDisplayedText(wasStreaming: boolean): void {
  const target = props.text;

  if (!props.streaming) {
    clearStreamFrame();
    replaceDisplayedText(target, !wasStreaming);
    return;
  }

  clearReplaceTransition();
  const current = displayedText.value;
  if (!target.startsWith(current) || current.length > target.length) {
    displayedText.value = target;
    clearStreamFrame();
    return;
  }

  scheduleStreamFrame();
}

function scheduleStreamFrame(): void {
  if (streamFrameId !== undefined) return;
  lastStreamFrameTime ||= performance.now();
  streamFrameId = window.requestAnimationFrame(tickDisplayedText);
}

function tickDisplayedText(now: number): void {
  streamFrameId = undefined;

  if (disposed) return;
  if (!props.streaming) {
    displayedText.value = props.text;
    return;
  }

  const current = displayedText.value;
  const target = props.text;
  if (!target.startsWith(current) || current.length > target.length) {
    displayedText.value = target;
    return;
  }

  const remaining = target.length - current.length;
  if (remaining <= 0) return;

  const elapsed = Math.max(16, now - lastStreamFrameTime);
  lastStreamFrameTime = now;
  const timeStep = Math.max(1, Math.floor(elapsed / 16));
  const catchupStep = Math.ceil(remaining / STREAM_CATCHUP_FRAMES);
  const step = Math.min(STREAM_MAX_CHARS_PER_FRAME, Math.max(timeStep, catchupStep));
  displayedText.value = target.slice(0, current.length + step);

  if (displayedText.value.length < target.length) scheduleStreamFrame();
}

function clearStreamFrame(): void {
  if (streamFrameId !== undefined) {
    window.cancelAnimationFrame(streamFrameId);
    streamFrameId = undefined;
  }
  lastStreamFrameTime = 0;
}

function replaceDisplayedText(target: string, animate: boolean): void {
  clearReplaceTransition();

  const current = displayedText.value;
  if (current === target) return;

  if (!animate || !current || !target) {
    displayedText.value = target;
    return;
  }

  replaceAnimating.value = true;
  replaceTimerId = window.setTimeout(() => {
    replaceTimerId = undefined;
    displayedText.value = target;
    replaceFrameId = window.requestAnimationFrame(() => {
      replaceFrameId = undefined;
      replaceAnimating.value = false;
    });
  }, REPLACE_OUT_MS);
}

function clearReplaceTransition(): void {
  if (replaceTimerId !== undefined) {
    window.clearTimeout(replaceTimerId);
    replaceTimerId = undefined;
  }

  if (replaceFrameId !== undefined) {
    window.cancelAnimationFrame(replaceFrameId);
    replaceFrameId = undefined;
  }

  replaceAnimating.value = false;
}

function scheduleMarkdownRender(): void {
  renderVersion += 1;

  if (!markdownReady.value) {
    clearScheduledRender();
    renderedHtml.value = '';
    return;
  }

  if (scheduled) return;

  const now = performance.now();
  const minDelay = props.streaming ? STREAM_RENDER_INTERVAL_MS : 0;
  const delay = Math.max(0, minDelay - (now - lastRenderTime));

  scheduled = true;
  timeoutId = window.setTimeout(() => {
    timeoutId = undefined;
    frameId = window.requestAnimationFrame(() => {
      frameId = undefined;
      scheduled = false;
      lastRenderTime = performance.now();
      void renderCurrentMarkdown(renderVersion);
    });
  }, delay);
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

  if (timeoutId !== undefined) {
    window.clearTimeout(timeoutId);
    timeoutId = undefined;
  }

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
