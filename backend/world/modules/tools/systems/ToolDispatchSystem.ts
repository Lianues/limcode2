import { defineQuery, defineSystem } from '../../../../ecs/types';
import { InFlight } from '../../chat/components';
import { PendingTool, RunningTool, ToolCall } from '../components';

const PendingToolCallsQuery = defineQuery({
  name: 'PendingToolCalls',
  all: [ToolCall, PendingTool],
  none: [InFlight],
  read: [ToolCall, PendingTool],
  remove: [PendingTool],
  add: [RunningTool, InFlight],
  mutationMode: 'consume',
  role: 'work'
});

export const ToolDispatchSystem = defineSystem({
  name: 'ToolDispatchSystem',
  worker: { modulePath: '../world/modules/tools/systems/ToolDispatchSystem', exportName: 'ToolDispatchSystem' },
  access: {
    queries: [PendingToolCallsQuery],
    effects: { emit: ['tool.run'] }
  },
  run({ world, cmd }) {
    const calls = world.query(ToolCall, PendingTool).filter((entity) => !world.has(entity, InFlight));
    if (calls.length === 0) return;

    for (const entity of calls) {
      const call = world.get(entity, ToolCall);
      if (!call) continue;
      cmd.effect({ kind: 'tool.run', toolCallId: call.id, name: call.name, argsJson: call.argsJson });
      cmd.remove(entity, PendingTool);
      cmd.add(entity, RunningTool, true);
      cmd.add(entity, InFlight, { kind: 'tool', startedAt: Date.now() });
    }
  }
});
