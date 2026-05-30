import { defineQuery, defineSystem } from '../../../../ecs/types';
import { InFlight } from '../../chat/components';
import { ToolCallEventBundle, spawnToolCallEvent } from '../bundles';
import { ToolCall, ToolState } from '../components';
import { transitionToolState } from '../state';

const QueuedToolCallsQuery = defineQuery({
  name: 'QueuedToolCalls',
  all: [ToolCall, ToolState],
  none: [InFlight],
  read: [ToolCall, ToolState],
  write: [ToolState],
  add: [InFlight],
  mutationMode: 'update',
  role: 'work'
});

export const ToolDispatchSystem = defineSystem({
  name: 'ToolDispatchSystem',
  worker: { modulePath: '../world/modules/tools/systems/ToolDispatchSystem', exportName: 'ToolDispatchSystem' },
  access: {
    queries: [QueuedToolCallsQuery],
    bundles: [ToolCallEventBundle],
    effects: { emit: ['tool.run'] }
  },
  run({ world, cmd }) {
    const calls = world
      .query(ToolCall, ToolState)
      .filter((entity) => !world.has(entity, InFlight) && world.get(entity, ToolState)?.status === 'queued');
    if (calls.length === 0) return;

    for (const entity of calls) {
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      if (!call || !state) continue;

      cmd.effect({ kind: 'tool.run', toolCallId: call.id, name: call.name, argsJson: call.argsJson });
      const now = Date.now();
      cmd.add(entity, ToolState, transitionToolState(state, 'executing', {}, now));
      spawnToolCallEvent(cmd, { toolCall: entity, toolCallId: call.id, kind: 'started', status: 'executing', at: now, elapsedMs: Math.max(0, now - call.createdAt) });
      cmd.add(entity, InFlight, { kind: 'tool', startedAt: now });
    }
  }
});
