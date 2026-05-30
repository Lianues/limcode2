import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import type { MsgRole, MsgStatus } from '../../../../shared/protocol';
import { LlmRequest, Message, PartOf, Session, Streaming } from './components';

export const SessionBundle = defineBundle({ name: 'SessionBundle', writes: [Session], mutationMode: 'create', spawns: true });
export const MessageBundle = defineBundle({ name: 'MessageBundle', writes: [Message, PartOf], mutationMode: 'create', spawns: true });
export const UserMessageBundle = defineBundle({ name: 'UserMessageBundle', writes: [Message, PartOf], mutationMode: 'create', spawns: true });
export const AssistantMessageBundle = defineBundle({ name: 'AssistantMessageBundle', writes: [Message, PartOf, Streaming], mutationMode: 'create', spawns: true });
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
  text: string;
  status?: MsgStatus;
}

export function spawnMessage(cmd: CommandSink, input: SpawnMessageInput): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, Message, {
    id: `m${entity}`,
    role: input.role,
    text: input.text,
    status: input.status ?? 'complete',
    seq: entity,
    createdAt: Date.now()
  });
  cmd.add(entity, PartOf, { parent: input.parent });
  return entity;
}

export function spawnUserMessage(cmd: CommandSink, session: Entity, text: string): Entity {
  return spawnMessage(cmd, { parent: session, role: 'user', text, status: 'complete' });
}

export function spawnAssistantMessage(cmd: CommandSink, session: Entity): Entity {
  const entity = spawnMessage(cmd, { parent: session, role: 'assistant', text: '', status: 'streaming' });
  cmd.add(entity, Streaming, true);
  return entity;
}

export function spawnToolResultMessage(
  cmd: CommandSink,
  input: { session: Entity; toolName: string; ok: boolean; output: string }
): Entity {
  return spawnMessage(cmd, {
    parent: input.session,
    role: 'tool',
    text: `[tool:${input.toolName}] ${input.ok ? 'ok' : 'failed'}\n${input.output}`,
    status: input.ok ? 'complete' : 'error'
  });
}

export function spawnLlmRequest(cmd: CommandSink, input: { session: Entity; assistant: Entity }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, LlmRequest, {
    id: `req${entity}`,
    sessionEntity: input.session,
    assistantEntity: input.assistant
  });
  return entity;
}
