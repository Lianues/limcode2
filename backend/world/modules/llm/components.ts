import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  LlmInvocationSettingsSnapshotRecord,
  LlmInvocationStatus,
  LlmUsageMetadataRecord,
  MessageLlmInvocationRole,
  RunLlmInvocationRole
} from '../../../../shared/protocol';

export interface LlmInvocationData {
  id: string;
  requestId: string;
  status: LlmInvocationStatus;
  settings?: LlmInvocationSettingsSnapshotRecord;
  createdAt: number;
  resolvedAt?: number;
  startedAt?: number;
  completedAt?: number;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  error?: string;
}
export const LlmInvocation = defineComponent<LlmInvocationData>('LlmInvocation');

export interface RunLlmInvocationLinkData {
  id: string;
  run: Entity;
  invocation: Entity;
  role: RunLlmInvocationRole;
  createdAt: number;
  updatedAt: number;
}
export const RunLlmInvocationLink = defineComponent<RunLlmInvocationLinkData>('RunLlmInvocationLink');

export interface MessageLlmInvocationLinkData {
  id: string;
  message: Entity;
  invocation: Entity;
  role: MessageLlmInvocationRole;
  createdAt: number;
  updatedAt: number;
}
export const MessageLlmInvocationLink = defineComponent<MessageLlmInvocationLinkData>('MessageLlmInvocationLink');
