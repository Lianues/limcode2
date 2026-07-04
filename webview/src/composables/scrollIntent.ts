export type UserScrollIntentDirection = 'toward-start' | 'toward-end' | 'jump-start' | 'jump-end' | 'none';

export interface UserScrollIntentDetail {
  direction: UserScrollIntentDirection;
  source?: string;
}

export const USER_SCROLL_INTENT_EVENT = 'limcode:user-scroll-intent';

export function dispatchUserScrollIntent(
  element: HTMLElement | null | undefined,
  detail: UserScrollIntentDetail
): void {
  if (!element) return;
  element.dispatchEvent(new CustomEvent<UserScrollIntentDetail>(USER_SCROLL_INTENT_EVENT, { detail }));
}

export function userScrollIntentDetail(event: Event): UserScrollIntentDetail | undefined {
  if (!(event instanceof CustomEvent)) return undefined;
  const detail = event.detail as Partial<UserScrollIntentDetail> | undefined;
  if (!detail || !isUserScrollIntentDirection(detail.direction)) return undefined;
  return {
    direction: detail.direction,
    ...(typeof detail.source === 'string' ? { source: detail.source } : {})
  };
}

function isUserScrollIntentDirection(value: unknown): value is UserScrollIntentDirection {
  return value === 'toward-start'
    || value === 'toward-end'
    || value === 'jump-start'
    || value === 'jump-end'
    || value === 'none';
}
