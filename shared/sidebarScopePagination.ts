export interface SidebarScopePageStateInput {
  currentPageIndex: number;
  pageSize: number;
  activeOptionIndex: number;
  hasReceivedState: boolean;
  previousActiveScopeKey: string;
  nextActiveScopeKey: string;
}

/** 内容刷新不应覆盖用户手动浏览的范围页；仅初始化或 active scope 真正变化时自动定位。 */
export function sidebarScopePageIndexAfterState(input: SidebarScopePageStateInput): number {
  if (input.hasReceivedState && input.previousActiveScopeKey === input.nextActiveScopeKey) {
    return input.currentPageIndex;
  }
  if (input.activeOptionIndex < 0) return input.currentPageIndex;
  const pageSize = Number.isFinite(input.pageSize) ? Math.max(1, Math.floor(input.pageSize)) : 1;
  return Math.floor(input.activeOptionIndex / pageSize);
}
