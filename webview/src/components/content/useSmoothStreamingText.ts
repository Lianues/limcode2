import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';

export interface SmoothStreamingTextOptions {
  animateReplace?: boolean;
  replaceOutMs?: number;
  catchupFrames?: number;
  maxCharsPerFrame?: number;
}

// 正文替换是“淡出旧内容 + 淡入新内容”的两段式动画。
// 每段 50ms，总体约 100ms，与消息进入动画保持同样节奏。
const DEFAULT_REPLACE_OUT_MS = 50;
const DEFAULT_CATCHUP_FRAMES = 14;
const DEFAULT_MAX_CHARS_PER_FRAME = 32;

export function useSmoothStreamingText(
  source: () => string,
  streaming: () => boolean,
  options: SmoothStreamingTextOptions = {}
) {
  const displayedText = shallowRef('');
  const replacing = ref(false);

  let streamFrameId: number | undefined;
  let lastStreamFrameTime = 0;
  let replaceTimerId: number | undefined;
  let replaceFrameId: number | undefined;
  let disposed = false;

  watch(
    () => [source(), streaming()] as const,
    (_next, previous) => syncDisplayedText(previous?.[1] ?? false),
    { immediate: true }
  );

  onBeforeUnmount(() => {
    disposed = true;
    clearStreamFrame();
    clearReplaceTransition();
  });

  function syncDisplayedText(wasStreaming: boolean): void {
    const target = source();

    if (!streaming()) {
      clearStreamFrame();
      replaceDisplayedText(target, (options.animateReplace ?? false) && !wasStreaming);
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
    if (!streaming()) {
      displayedText.value = source();
      return;
    }

    const current = displayedText.value;
    const target = source();
    if (!target.startsWith(current) || current.length > target.length) {
      displayedText.value = target;
      return;
    }

    const remaining = target.length - current.length;
    if (remaining <= 0) return;

    const elapsed = Math.max(16, now - lastStreamFrameTime);
    lastStreamFrameTime = now;
    const timeStep = Math.max(1, Math.floor(elapsed / 16));
    const catchupStep = Math.ceil(remaining / (options.catchupFrames ?? DEFAULT_CATCHUP_FRAMES));
    const step = Math.min(options.maxCharsPerFrame ?? DEFAULT_MAX_CHARS_PER_FRAME, Math.max(timeStep, catchupStep));
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

    replacing.value = true;
    replaceTimerId = window.setTimeout(() => {
      replaceTimerId = undefined;
      displayedText.value = target;
      replaceFrameId = window.requestAnimationFrame(() => {
        replaceFrameId = undefined;
        replacing.value = false;
      });
    }, options.replaceOutMs ?? DEFAULT_REPLACE_OUT_MS);
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

    replacing.value = false;
  }

  return { displayedText, replacing };
}
