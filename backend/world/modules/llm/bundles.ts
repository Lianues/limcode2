import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import type { LlmInvocationSettingsSnapshotRecord, LlmInvocationStatus } from '../../../../shared/protocol';
import { LlmInvocation, MessageLlmInvocationLink, RunLlmInvocationLink } from './components';

export const LlmInvocationBundle = defineBundle({ name: 'LlmInvocationBundle', writes: [LlmInvocation, RunLlmInvocationLink], mutationMode: 'create', spawns: true });
export const MessageLlmInvocationLinkBundle = defineBundle({ name: 'MessageLlmInvocationLinkBundle', writes: [MessageLlmInvocationLink], mutationMode: 'create', spawns: true });

export interface SpawnLlmInvocationInput {
  requestId?: string;
  status?: LlmInvocationStatus;
  settings?: LlmInvocationSettingsSnapshotRecord;
  createdAt?: number;
}

export function spawnLlmInvocation(cmd: CommandSink, input: SpawnLlmInvocationInput = {}): Entity {
  const entity = cmd.spawn();
  const createdAt = input.createdAt ?? Date.now();
  cmd.add(entity, LlmInvocation, {
    id: `llmi${entity}`,
    requestId: input.requestId ?? `req${entity}`,
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
    id: `rlil${entity}`,
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
    id: `mlil${entity}`,
    message: input.message,
    invocation: input.invocation,
    role: input.role ?? 'modelOutput',
    createdAt,
    updatedAt: createdAt
  });
  return entity;
}
