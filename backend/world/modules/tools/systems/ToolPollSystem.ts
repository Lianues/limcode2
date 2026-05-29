import { defineQuery, defineSystem } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { InFlight } from '../../chat/components';
import { ToolEventType } from '../events';
import { RunningTool, ToolCall, ToolCompleted, ToolFailed, ToolResult } from '../components';

const ToolCallsByIdQuery = defineQuery({
  name: 'ToolCallsById',
  all: [ToolCall],
  read: [ToolCall],
  add: [ToolResult, ToolCompleted, ToolFailed],
  remove: [RunningTool, InFlight],
  mutationMode: 'consume',
  role: 'lookup'
});

export const ToolPollSystem = defineSystem({
  name: 'ToolPollSystem',
  worker: { modulePath: '../world/modules/tools/systems/ToolPollSystem', exportName: 'ToolPollSystem' },
  access: {
    queries: [ToolCallsByIdQuery],
    events: { read: [ToolEventType.Done] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ToolEventType.Done)) {
      const entity = world.query(ToolCall).find((candidate) => world.get(candidate, ToolCall)?.id === payload.toolCallId);
      if (entity === undefined) continue;
      cmd.add(entity, ToolResult, { ok: payload.ok, output: payload.output });
      cmd.remove(entity, RunningTool);
      cmd.remove(entity, InFlight);
      cmd.add(entity, payload.ok ? ToolCompleted : ToolFailed, true);
    }
  }
});
