import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import { createStableId } from '../../../utils/stableId';
import type { LlmInvocationSettingsSnapshotRecord, LlmInvocationStatus } from '../../../../shared/protocol';
import { LlmInvocation, MessageLlmInvocationLink, RunLlmInvocationLink } from './components';

export const LlmInvocationBundle = defineBundle({ name: 'LlmInvocationBundle', writes: [LlmInvocation, RunLlmInvocationLink], mutationMode: 'create', spawns: true });
export const MessageLlmInvocationLinkBundle = defineBundle({ name: 'MessageLlmInvocationLinkBundle', writes: [MessageLlmInvocationLink], mutationMode: 'create', spawns: true });

export interface SpawnLlmInvocationInput {
  id?: string;
  requestId?: string;
  status?: LlmInvocationStatus;
  settings?: LlmInvocationSettingsSnapshotRecord;
  createdAt?: number;
}

export function spawnLlmInvocation(cmd: CommandSink, input: SpawnLlmInvocationInput = {}): Entity {
  const entity = cmd.spawn();
  const createdAt = input.createdAt ?? Date.now();
  cmd.add(entity, LlmInvocation, {
    id: input.id ?? createStableId('llmi'),
    requestId: input.requestId ?? createStableId('llmreq'),
    status: input.status ?? 'resolving',
    ...(input.settings !== undefined ? { settings: input.settings } : {}),
    createdAt
  });
  return entity;
}

export function spawnRunLlmInvocationLink(cmd: CommandSink, input: { run: Entity; invocation: Entity; role?: 'primary'; createdAt?: number }): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  const createdAt = input.createdAt ?? now;
  cmd.add(entity, RunLlmInvocationLink, {
    id: createStableId('rlil'),
    run: input.run,
    invocation: input.invocation,
    role: input.role ?? 'primary',
    createdAt,
    updatedAt: createdAt
  });
  return entity;
}

export function spawnMessageLlmInvocationLink(cmd: CommandSink, input: { message: Entity; invocation: Entity; role?: 'modelOutput'; createdAt?: number }): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  const createdAt = input.createdAt ?? now;
  cmd.add(entity, MessageLlmInvocationLink, {
    id: createStableId('mlil'),
    message: input.message,
    invocation: input.invocation,
    role: input.role ?? 'modelOutput',
    createdAt,
    updatedAt: createdAt
  });
  return entity;
}
