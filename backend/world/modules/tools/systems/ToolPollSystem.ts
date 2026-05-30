import { defineQuery, defineSystem } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { InFlight } from '../../chat/components';
import { ToolCall, ToolState } from '../components';
import { ToolEventType } from '../events';
import { isTerminalToolStatus, transitionToolState } from '../state';

const ToolCallsByIdQuery = defineQuery({
  name: 'ToolCallsById',
  all: [ToolCall, ToolState],
  read: [ToolCall, ToolState],
  write: [ToolState],
  remove: [InFlight],
  mutationMode: 'update',
  role: 'lookup'
});

export const ToolPollSystem = defineSystem({
  name: 'ToolPollSystem',
  worker: { modulePath: '../world/modules/tools/systems/ToolPollSystem', exportName: 'ToolPollSystem' },
  access: {
    queries: [ToolCallsByIdQuery],
    events: { read: [ToolEventType.State] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ToolEventType.State)) {
      const entity = world.query(ToolCall, ToolState).find((candidate) => world.get(candidate, ToolCall)?.id === payload.toolCallId);
      if (entity === undefined) continue;

      const current = world.get(entity, ToolState);
      if (!current) continue;

      try {
        const next = transitionToolState(current, payload.status, {
          result: payload.result,
          error: payload.error,
          progress: payload.progress
        });
        cmd.add(entity, ToolState, next);
        if (isTerminalToolStatus(next.status)) {
          cmd.remove(entity, InFlight);
        }
      } catch (error) {
        console.warn('[LimCode] Ignored invalid tool state transition:', error);
      }
    }
  }
});
