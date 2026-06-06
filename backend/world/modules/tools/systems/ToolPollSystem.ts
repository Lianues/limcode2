import { defineQuery, defineSystem } from '../../../../ecs/types';
import { readEvents } from '../../../events';
import { InFlight } from '../../chat/components';
import { ToolCallEventBundle, spawnToolCallEvent } from '../bundles';
import { ToolCall, ToolState } from '../components';
import { ToolEventType } from '../events';
import { isTerminalToolStatus, transitionToolState } from '../state';
import type { ToolCallEventKind } from '../../../../../shared/protocol';

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
  shouldRun(ctx) {
    return readEvents(ctx, ToolEventType.State).length > 0;
  },
  access: {
    queries: [ToolCallsByIdQuery],
    bundles: [ToolCallEventBundle],
    events: { read: [ToolEventType.State] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    for (const payload of readEvents(ctx, ToolEventType.State)) {
      const entity = world.query(ToolCall, ToolState).find((candidate) => world.get(candidate, ToolCall)?.id === payload.toolCallId);
      if (entity === undefined) continue;

      const call = world.get(entity, ToolCall);
      const current = world.get(entity, ToolState);
      if (!call || !current) continue;

      try {
        const now = Date.now();
        const isOutputEvent = payload.eventKind === 'stdout' || payload.eventKind === 'stderr';
        const next = transitionToolState(current, payload.status, {
          result: payload.result,
          error: payload.error,
          progress: payload.progress,
          delta: isOutputEvent ? undefined : payload.delta,
          durationMs: payload.durationMs
        }, now);
        cmd.add(entity, ToolState, next);
        spawnToolCallEvent(cmd, {
          toolCall: entity,
          toolCallId: call.id,
          kind: eventKindForPayload(payload.eventKind, next.status),
          status: next.status,
          at: now,
          elapsedMs: Math.max(0, now - call.createdAt),
          durationMs: payload.durationMs,
          delta: payload.delta,
          payload: payload.progress ?? payload.result,
          error: payload.error
        });
        if (isTerminalToolStatus(next.status)) {
          cmd.remove(entity, InFlight);
        }
      } catch (error) {
        console.warn('[LimCode] Ignored invalid tool state transition:', error);
      }
    }
  }
});

function eventKindForPayload(preferred: ToolCallEventKind | undefined, status: ReturnType<typeof transitionToolState>['status']): ToolCallEventKind {
  if (preferred) return preferred;
  if (status === 'success' || status === 'warning') return 'completed';
  if (status === 'error') return 'failed';
  if (status === 'executing') return 'progress';
  return 'state';
}
