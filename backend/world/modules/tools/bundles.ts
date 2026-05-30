import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import { PartOf } from '../chat/components';
import { ToolCall, ToolState } from './components';
import { createToolState } from './state';
import type { ToolCallStatus } from '../../../../shared/protocol';

export const ToolCallBundle = defineBundle({ name: 'ToolCallBundle', writes: [ToolCall, PartOf, ToolState], mutationMode: 'create', spawns: true });

export function spawnToolCall(cmd: CommandSink, input: { modelMessage: Entity; id?: string; name: string; argsJson: string; initialStatus?: ToolCallStatus }): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  const id = input.id ?? `tc${entity}`;
  cmd.add(entity, ToolCall, { id, functionCallId: id, name: input.name, argsJson: input.argsJson, createdAt: now });
  cmd.add(entity, PartOf, { parent: input.modelMessage });
  cmd.add(entity, ToolState, createToolState(input.initialStatus ?? 'queued', now));
  return entity;
}
