import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import { PartOf } from '../chat/components';
import { PendingTool, ToolCall } from './components';

export const ToolCallBundle = defineBundle({ name: 'ToolCallBundle', writes: [ToolCall, PartOf, PendingTool], mutationMode: 'create', spawns: true });

export function spawnToolCall(cmd: CommandSink, input: { assistant: Entity; name: string; argsJson: string }): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, ToolCall, { id: `tc${entity}`, name: input.name, argsJson: input.argsJson });
  cmd.add(entity, PartOf, { parent: input.assistant });
  cmd.add(entity, PendingTool, true);
  return entity;
}
