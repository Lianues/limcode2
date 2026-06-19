import type {
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
}

declare module '@backend/world/effects' {
  interface WorldEffectMap {
    'checkpoint.create': CheckpointCreateEffect;
  }
}
