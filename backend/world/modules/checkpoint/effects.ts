import type {
  CheckpointFloorAnchorPosition,
  CheckpointPolicyRecord,
  CheckpointTriggerKind
} from '../../../../shared/protocol';

export interface CheckpointCreateEffect {
  kind: 'checkpoint.create';
  checkpointId: string;
  conversationId: string;
  projectContextId: string;
  projectUri: string;
  projectDisplayPath: string;
  shadowRepositoryId: string;
  shadowRepositoryStorageKey: string;
  trigger: CheckpointTriggerKind;
  policy: CheckpointPolicyRecord;
  floorMessageId?: string;
  anchorPosition?: CheckpointFloorAnchorPosition;
  sourceRunId?: string;
  sourceToolCallId?: string;
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'checkpoint.create': CheckpointCreateEffect;
  }
}
