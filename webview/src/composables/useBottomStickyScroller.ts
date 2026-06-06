import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue';

export interface BottomStickyScrollerOptions {
  /** 距离底部多少像素内视为“贴底”。 */
  thresholdPx?: number;
  /** 内容高度变化后继续贴底的时间，用于覆盖折叠/流式动画。 */
  settleMs?: number;
  /** 折叠/展开等显式内容高度交互前，允许稍大的预吸附误差。 */
  interactionThresholdPx?: number;
}

export interface BottomStickyScroller {
  scrollToBottom: () => void;
  scrollToBottomNow: () => void;
  isNearBottom: () => boolean;
  isStickyToBottom: () => boolean;
}

const DEFAULT_THRESHOLD_PX = 1;
const DEFAULT_INTERACTION_THRESHOLD_PX = 5;
const DEFAULT_SETTLE_MS = 260;

/**
 * 统一管理滚动容器的底部粘滞行为。
 *
 * 只要用户当前贴近底部，后续任何内容高度变化都会保持滚动到底部：
 * - 新消息/流式正文文本增长
 * - 流式思考文本增长
 * - 思考/工具调用等折叠块展开收起
 * - 图片/附件等异步尺寸变化
 *
 * 内容组件不需要单独维护滚动行为，只负责渲染自身内容。
 */
export function useBottomStickyScroller(
  scroller: Ref<HTMLElement | null>,
  options: BottomStickyScrollerOptions = {}
): BottomStickyScroller {
  const thresholdPx = options.thresholdPx ?? DEFAULT_THRESHOLD_PX;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const interactionThresholdPx = Math.max(
    thresholdPx,
    options.interactionThresholdPx ?? DEFAULT_INTERACTION_THRESHOLD_PX
  );

  let observedScroller: HTMLElement | null = null;
  let observedContent: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | undefined;
  let mutationObserver: MutationObserver | undefined;
  let stickyToBottom = true;
  let stickyFrame: number | undefined;
  let contentCheckFrame: number | undefined;
  let stickyUntil = 0;

  function isNearBottomElement(element: HTMLElement, threshold = thresholdPx): boolean {
    return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
  }

  function isNearBottom(): boolean {
    const element = scroller.value;
    return !element || isNearBottomElement(element);
  }

  function isStickyToBottom(): boolean {
    return stickyToBottom;
  }

  function scrollToBottomNow(): void {
    const element = scroller.value;
    if (element) element.scrollTop = element.scrollHeight;
  }

  function scrollToBottom(): void {
    void nextTick(scrollToBottomNow);
  }

  function updateStickyFromUserScroll(): void {
    const element = scroller.value;
    if (stickyToBottom && performance.now() < stickyUntil) {
      return;
    }

    stickyToBottom = !element || isNearBottomElement(element);
  }

  function primeStickyFromBottomInteraction(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[aria-expanded]')) return;

    const element = scroller.value;
    if (!element || !isNearBottomElement(element, interactionThresholdPx)) return;

    stickyToBottom = true;
    scrollToBottomNow();
    keepStickyDuringContentSettle();
  }

  function primeStickyFromKeyboardInteraction(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    primeStickyFromBottomInteraction(event);
  }

  function keepStickyDuringContentSettle(): void {
    if (!stickyToBottom) return;
    scrollToBottomNow();

    stickyUntil = Math.max(stickyUntil, performance.now() + settleMs);
    if (stickyFrame !== undefined) return;

    const tick = (): void => {
      if (!stickyToBottom) {
        stickyFrame = undefined;
        return;
      }

      scrollToBottomNow();
      if (performance.now() < stickyUntil) {
        stickyFrame = window.requestAnimationFrame(tick);
        return;
      }

      stickyFrame = undefined;
    };

    stickyFrame = window.requestAnimationFrame(tick);
  }

  function onContentMayHaveChanged(): void {
    const element = scroller.value;
    if (!element) return;

    const wasSticky = stickyToBottom;
    const nowNearBottom = isNearBottomElement(element);
    stickyToBottom = wasSticky || nowNearBottom;

    if (stickyToBottom) keepStickyDuringContentSettle();
  }

  function scheduleContentCheck(): void {
    if (contentCheckFrame !== undefined) return;

    contentCheckFrame = window.requestAnimationFrame(() => {
      contentCheckFrame = undefined;
      refreshObservedContentRoot();
      onContentMayHaveChanged();
    });
  }

  function refreshObservedContentRoot(): void {
    if (!resizeObserver || !observedScroller) return;

    const nextContent = observedScroller.firstElementChild instanceof HTMLElement
      ? observedScroller.firstElementChild
      : null;
    if (nextContent === observedContent) return;

    if (observedContent) resizeObserver.unobserve(observedContent);
    observedContent = nextContent;
    if (observedContent) resizeObserver.observe(observedContent);
  }

  function attachScroller(element: HTMLElement | null): void {
    detachScroller();

    if (!element) {
      stickyToBottom = true;
      return;
    }

    observedScroller = element;
    stickyToBottom = isNearBottomElement(element);
    element.addEventListener('scroll', updateStickyFromUserScroll, { passive: true });
    element.addEventListener('pointerdown', primeStickyFromBottomInteraction, { capture: true });
    element.addEventListener('keydown', primeStickyFromKeyboardInteraction, { capture: true });

    resizeObserver = new ResizeObserver(scheduleContentCheck);
    resizeObserver.observe(element);

    observedContent = element.firstElementChild instanceof HTMLElement ? element.firstElementChild : null;
    if (observedContent) resizeObserver.observe(observedContent);

    mutationObserver = new MutationObserver(scheduleContentCheck);
    mutationObserver.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    });

    scheduleContentCheck();
  }

  function detachScroller(): void {
    if (observedScroller) {
      observedScroller.removeEventListener('scroll', updateStickyFromUserScroll);
      observedScroller.removeEventListener('pointerdown', primeStickyFromBottomInteraction, { capture: true });
      observedScroller.removeEventListener('keydown', primeStickyFromKeyboardInteraction, { capture: true });
    }
    observedScroller = null;
    observedContent = null;

    resizeObserver?.disconnect();
    resizeObserver = undefined;
    mutationObserver?.disconnect();
    mutationObserver = undefined;

    if (stickyFrame !== undefined) window.cancelAnimationFrame(stickyFrame);
    stickyFrame = undefined;
    if (contentCheckFrame !== undefined) window.cancelAnimationFrame(contentCheckFrame);
    contentCheckFrame = undefined;
  }

  watch(scroller, attachScroller, { immediate: true, flush: 'post' });
  onBeforeUnmount(detachScroller);

  return {
    scrollToBottom,
    scrollToBottomNow,
    isNearBottom,
    isStickyToBottom
  };
}
