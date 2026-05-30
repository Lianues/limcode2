import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import { PartOf } from '../chat/components';
import { ToolCall, ToolCallEvent, ToolState } from './components';
import { createToolState } from './state';
import type { ToolCallEventKind, ToolCallStatus } from '../../../../shared/protocol';

export const ToolCallBundle = defineBundle({ name: 'ToolCallBundle', writes: [ToolCall, PartOf, ToolState, ToolCallEvent], mutationMode: 'create', spawns: true });
export const ToolCallEventBundle = defineBundle({ name: 'ToolCallEventBundle', writes: [ToolCallEvent, PartOf], mutationMode: 'create', spawns: true });

export interface SpawnToolCallEventInput {
  toolCall: Entity;
  toolCallId: string;
  kind: ToolCallEventKind;
  at?: number;
  status?: ToolCallStatus;
  elapsedMs?: number;
  durationMs?: number;
  delta?: string;
  payload?: unknown;
  error?: string;
}

export function spawnToolCall(cmd: CommandSink, input: { modelMessage: Entity; id?: string; name: string; argsJson: string; initialStatus?: ToolCallStatus }): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  const id = input.id ?? `tc${entity}`;
  const status = input.initialStatus ?? 'queued';
  cmd.add(entity, ToolCall, { id, functionCallId: id, name: input.name, argsJson: input.argsJson, createdAt: now });
  cmd.add(entity, PartOf, { parent: input.modelMessage });
  cmd.add(entity, ToolState, createToolState(status, now));
  spawnToolCallEvent(cmd, { toolCall: entity, toolCallId: id, kind: 'created', status, at: now, payload: { name: input.name, argsJson: input.argsJson } });
  return entity;
}

export function spawnToolCallEvent(cmd: CommandSink, input: SpawnToolCallEventInput): Entity {
  const entity = cmd.spawn();
  const at = input.at ?? Date.now();
  cmd.add(entity, ToolCallEvent, {
    id: `tce${entity}`,
    toolCallId: input.toolCallId,
    seq: entity,
    kind: input.kind,
    at,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.delta !== undefined ? { delta: input.delta } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.error !== undefined ? { error: input.error } : {})
  });
  cmd.add(entity, PartOf, { parent: input.toolCall });
  return entity;
}
