import type {
  CheckpointPolicyScopeClearPayload,
  CheckpointPolicyScopeSetPayload,
  CheckpointSkipReason,
  CheckpointStatus,
  CheckpointTriggerKind
} from '../../../../shared/protocol';

export interface CheckpointRequestedPayload {
  conversationId: string;
  trigger: CheckpointTriggerKind;
  runId?: string;
  toolCallId?: string;
}

export interface CheckpointCompletedPayload {
  checkpointId: string;
  conversationId: string;
  projectContextId: string;
  shadowRepositoryId: string;
  trigger: CheckpointTriggerKind;
  status: CheckpointStatus;
  projectUri: string;
  projectDisplayPath: string;
  createdAt: number;
  updatedAt: number;
  commitSha?: string;
  skipReason?: CheckpointSkipReason;
  message?: string;
  fileCount?: number;
  byteCount?: number;
  emptyDirectoryCount?: number;
}

export const CheckpointEventType = {
  Requested: 'checkpoint:requested',
  Completed: 'checkpoint:completed',
  PolicyScopeSetRequested: 'checkpointPolicy:scopeSetRequested',
  PolicyScopeClearRequested: 'checkpointPolicy:scopeClearRequested'
} as const;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'checkpoint:requested': CheckpointRequestedPayload;
    'checkpoint:completed': CheckpointCompletedPayload;
    'checkpointPolicy:scopeSetRequested': CheckpointPolicyScopeSetPayload;
    'checkpointPolicy:scopeClearRequested': CheckpointPolicyScopeClearPayload;
  }
}
