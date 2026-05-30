import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import type { ContentPart, ContentRole, MsgRole, MsgStatus } from '../../../../shared/protocol';
import { LlmRequest, Message, PartOf, Session, Streaming } from './components';

export const SessionBundle = defineBundle({ name: 'SessionBundle', writes: [Session], mutationMode: 'create', spawns: true });
export const MessageBundle = defineBundle({ name: 'MessageBundle', writes: [Message, PartOf], mutationMode: 'create', spawns: true });
export const UserMessageBundle = defineBundle({ name: 'UserMessageBundle', writes: [Message, PartOf], mutationMode: 'create', spawns: true });
export const ModelMessageBundle = defineBundle({ name: 'ModelMessageBundle', writes: [Message, PartOf, Streaming], mutationMode: 'create', spawns: true });
export const ToolResultMessageBundle = defineBundle({ name: 'ToolResultMessageBundle', writes: [Message, PartOf], mutationMode: 'create', spawns: true });
export const LlmRequestBundle = defineBundle({ name: 'LlmRequestBundle', writes: [LlmRequest], mutationMode: 'create', spawns: true });

export function spawnSession(cmd: CommandSink, input: { id: string; title?: string }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, Session, { id: input.id, title: input.title });
  return entity;
}

export interface SpawnMessageInput {
  parent: Entity;
  role: MsgRole;
  parts?: ContentPart[];
  status?: MsgStatus;
}

export function spawnMessage(cmd: CommandSink, input: SpawnMessageInput): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, Message, {
    id: `m${entity}`,
    role: input.role,
    content: {
      role: contentRoleForMessage(input.role),
      parts: input.parts ?? []
    },
    status: input.status ?? 'complete',
    seq: entity,
    createdAt: Date.now()
  });
  cmd.add(entity, PartOf, { parent: input.parent });
  return entity;
}

export function spawnUserMessage(cmd: CommandSink, session: Entity, text: string): Entity {
  return spawnMessage(cmd, { parent: session, role: 'user', parts: [{ type: 'text', text }], status: 'complete' });
}

export function spawnModelMessage(cmd: CommandSink, session: Entity): Entity {
  const entity = spawnMessage(cmd, { parent: session, role: 'model', parts: [], status: 'streaming' });
  cmd.add(entity, Streaming, true);
  return entity;
}

function contentRoleForMessage(role: MsgRole): ContentRole { return role; }

export function spawnToolResultMessage(
  cmd: CommandSink,
  input: { session: Entity; toolName: string; status: 'success' | 'warning' | 'error'; response: unknown; durationMs?: number }
): Entity {
  return spawnMessage(cmd, {
    parent: input.session,
    role: 'tool',
    parts: [{
      type: 'functionResponse',
      id: input.toolName,
      name: input.toolName,
      response: input.response,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {})
    }],
    status: input.status === 'error' ? 'error' : 'complete'
  });
}

export function spawnToolResponseMessage(
  cmd: CommandSink,
  input: { session: Entity; toolCallId: string; toolName: string; status: 'success' | 'warning' | 'error'; response: unknown; durationMs?: number }
): Entity {
  return spawnMessage(cmd, {
    parent: input.session,
    role: 'tool',
    parts: [{
      type: 'functionResponse',
      id: input.toolCallId,
      name: input.toolName,
      response: input.response,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {})
    }],
    status: input.status === 'error' ? 'error' : 'complete'
  });
}

export function spawnLlmRequest(cmd: CommandSink, input: { session: Entity; modelMessage: Entity }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, LlmRequest, {
    id: `req${entity}`,
    sessionEntity: input.session,
    modelMessageEntity: input.modelMessage
  });
  return entity;
}
