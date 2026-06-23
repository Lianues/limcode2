import type { RuntimeContextRefreshPayload, RuntimeContextScopeClearPayload, RuntimeContextScopeSetPayload, RuntimeContextSnapshotClearPayload } from '../../../../shared/protocol';

export const RuntimeContextEventType = {
  ScopeSet: 'runtimeContext:scopeSet',
  ScopeClear: 'runtimeContext:scopeClear',
  Refresh: 'runtimeContext:refresh',
  SnapshotClear: 'runtimeContext:snapshotClear'
} as const;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'runtimeContext:scopeSet': RuntimeContextScopeSetPayload;
    'runtimeContext:scopeClear': RuntimeContextScopeClearPayload;
    'runtimeContext:refresh': RuntimeContextRefreshPayload;
    'runtimeContext:snapshotClear': RuntimeContextSnapshotClearPayload;
  }
}
