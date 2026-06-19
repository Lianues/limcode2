import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  CheckpointPolicyRecord,
  CheckpointPolicyScopeKind,
  CheckpointFloorAnchorPosition,
  CheckpointRepositoryLinkRole,
  CheckpointSkipReason,
  CheckpointStatus,
  CheckpointTriggerKind,
  ConfigScopeBindingRole
} from '../../../../shared/protocol';

export type CheckpointPolicyData = CheckpointPolicyRecord;
export const CheckpointPolicy = defineComponent<CheckpointPolicyData>('CheckpointPolicy');

export interface CheckpointPolicyScopeLinkData {
  id: string;
  scopeKind: CheckpointPolicyScopeKind;
  scopeId?: string;
  checkpointPolicy: Entity;
  conversation?: Entity;
  agent?: Entity;
  mode?: Entity;
  run?: Entity;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const CheckpointPolicyScopeLink = defineComponent<CheckpointPolicyScopeLinkData>('CheckpointPolicyScopeLink');

export interface ShadowRepositoryData {
  id: string;
  storageKey: string;
  createdAt: number;
  updatedAt: number;
}
export const ShadowRepository = defineComponent<ShadowRepositoryData>('ShadowRepository');

export interface ConversationCheckpointRepositoryLinkData {
  id: string;
  conversation: Entity;
  projectContext: Entity;
  shadowRepository: Entity;
  projectUri: string;
  projectDisplayPath: string;
  role: CheckpointRepositoryLinkRole;
  createdAt: number;
  updatedAt: number;
}
export const ConversationCheckpointRepositoryLink = defineComponent<ConversationCheckpointRepositoryLinkData>('ConversationCheckpointRepositoryLink');

export interface CheckpointData {
  id: string;
  conversation: Entity;
  projectContext: Entity;
  shadowRepository: Entity;
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
export const Checkpoint = defineComponent<CheckpointData>('Checkpoint');

export interface CheckpointTimelineAnchorData {
  id: string;
  conversation: Entity;
  checkpoint: Entity;
  floorMessage: Entity;
  position: CheckpointFloorAnchorPosition;
  order: number;
  sourceRun?: Entity;
  sourceRunId?: string;
  sourceToolCall?: Entity;
  sourceToolCallId?: string;
  createdAt: number;
  updatedAt: number;
}
export const CheckpointTimelineAnchor = defineComponent<CheckpointTimelineAnchorData>('CheckpointTimelineAnchor');
