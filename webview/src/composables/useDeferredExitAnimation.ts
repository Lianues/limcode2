import { onBeforeUnmount, ref } from 'vue';

export interface DeferredExitAnimationOptions {
  durationMs?: number;
  clearDelayMs?: number;
}

/**
 * 用于“先播放退出动画，再执行真实动作”的通用时序控制。
 * 例如消息删除、重试、编辑后删除后续消息，都可以复用同一套状态和计时逻辑。
 */
export function useDeferredExitAnimation(options: DeferredExitAnimationOptions = {}) {
  const durationMs = options.durationMs ?? 180;
  const clearDelayMs = options.clearDelayMs ?? 2000;
  const exitingFromId = ref<string>();

  let actionTimer: number | undefined;
  let clearTimer: number | undefined;

  onBeforeUnmount(() => {
    clearTimers();
  });

  function playFrom(id: string, action: () => void, delay = durationMs): void {
    clearTimers();
    exitingFromId.value = id;
    actionTimer = window.setTimeout(() => {
      action();
      actionTimer = undefined;
      clearTimer = window.setTimeout(clear, clearDelayMs);
    }, delay);
  }

  function clear(): void {
    exitingFromId.value = undefined;
    if (clearTimer !== undefined) {
      window.clearTimeout(clearTimer);
      clearTimer = undefined;
    }
  }

  function clearTimers(): void {
    if (actionTimer !== undefined) {
      window.clearTimeout(actionTimer);
      actionTimer = undefined;
    }
    if (clearTimer !== undefined) {
      window.clearTimeout(clearTimer);
      clearTimer = undefined;
    }
  }

  return { exitingFromId, playFrom, clear };
}
