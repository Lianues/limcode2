import type {
  CheckpointFloorAnchorPosition,
  CheckpointPolicyScopeClearPayload,
  CheckpointPolicyScopeSetPayload,
  CheckpointSkipReason,
  CheckpointStatus,
  CheckpointTriggerKind
} from '../../../../shared/protocol';

export interface CheckpointRequestedPayload {
  checkpointId?: string;
  conversationId: string;
  trigger: CheckpointTriggerKind;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  floorMessageId?: string;
  anchorPosition?: CheckpointFloorAnchorPosition;
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
  floorMessageId?: string;
  anchorPosition?: CheckpointFloorAnchorPosition;
  sourceRunId?: string;
  sourceToolCallId?: string;
  sourceToolName?: string;
}

export interface CheckpointDismissRequestedPayload {
  checkpointId: string;
}

export const CheckpointEventType = {
  Requested: 'checkpoint:requested',
  Completed: 'checkpoint:completed',
  DismissRequested: 'checkpoint:dismissRequested',
  PolicyScopeSetRequested: 'checkpointPolicy:scopeSetRequested',
  PolicyScopeClearRequested: 'checkpointPolicy:scopeClearRequested'
} as const;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'checkpoint:requested': CheckpointRequestedPayload;
    'checkpoint:completed': CheckpointCompletedPayload;
    'checkpoint:dismissRequested': CheckpointDismissRequestedPayload;
    'checkpointPolicy:scopeSetRequested': CheckpointPolicyScopeSetPayload;
    'checkpointPolicy:scopeClearRequested': CheckpointPolicyScopeClearPayload;
  }
}
