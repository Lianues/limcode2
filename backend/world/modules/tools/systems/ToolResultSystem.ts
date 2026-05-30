import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { NeedsResponse, PartOf } from '../../chat/components';
import { spawnToolResponseMessage, ToolResultMessageBundle } from '../../chat/bundles';
import { ToolCall, ToolResultConsumed, ToolState } from '../components';
import { isTerminalToolStatus, toolStateToResponse } from '../state';

const SettledToolCallsQuery = defineQuery({
  name: 'SettledToolCalls',
  all: [ToolCall, ToolState],
  none: [ToolResultConsumed],
  read: [ToolCall, ToolState],
  add: [ToolResultConsumed, NeedsResponse],
  mutationMode: 'consume',
  role: 'work'
});

const ToolParentLookupQuery = defineQuery({
  name: 'ToolParentLookup',
  all: [PartOf],
  read: [PartOf],
  role: 'lookup'
});

const ActiveToolWorkLookupQuery = defineQuery({
  name: 'ActiveToolWorkLookup',
  all: [ToolCall, ToolState],
  read: [ToolCall, ToolState, PartOf, ToolResultConsumed],
  role: 'lookup'
});

export const ToolResultSystem = defineSystem({
  name: 'ToolResultSystem',
  worker: { modulePath: '../world/modules/tools/systems/ToolResultSystem', exportName: 'ToolResultSystem' },
  access: {
    queries: [SettledToolCallsQuery, ToolParentLookupQuery, ActiveToolWorkLookupQuery],
    bundles: [ToolResultMessageBundle]
  },
  run({ world, cmd }) {
    const settled = world
      .query(ToolCall, ToolState)
      .filter((entity) => {
        const state = world.get(entity, ToolState);
        return !!state && isTerminalToolStatus(state.status) && !world.has(entity, ToolResultConsumed);
      });
    if (settled.length === 0) return;

    const touchedSessions = new Set<Entity>();
    const consumedThisPass = new Set<Entity>();
    for (const entity of settled) {
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      const modelMessage = world.get(entity, PartOf)?.parent;
      if (!call || !state || modelMessage === undefined) continue;
      if (!isTerminalToolStatus(state.status)) continue;
      const session = world.get(modelMessage, PartOf)?.parent;
      if (session === undefined) continue;

      spawnToolResponseMessage(cmd, {
        session,
        toolCallId: call.functionCallId ?? call.id,
        toolName: call.name,
        status: state.status,
        response: toolStateToResponse(state),
        durationMs: state.durationMs
      });
      cmd.add(entity, ToolResultConsumed, true);
      consumedThisPass.add(entity);
      touchedSessions.add(session);
    }

    for (const session of touchedSessions) {
      if (!hasPendingToolWork(world, session, consumedThisPass)) cmd.add(session, NeedsResponse, { since: Date.now() });
    }
  }
});

function hasPendingToolWork(world: WorldReader, session: Entity, consumedThisPass: ReadonlySet<Entity>): boolean {
  return world.query(ToolCall, ToolState).some((entity) => {
    const modelMessage = world.get(entity, PartOf)?.parent;
    if (modelMessage === undefined) return false;
    if (world.get(modelMessage, PartOf)?.parent !== session) return false;

    const state = world.get(entity, ToolState);
    if (!state) return false;

    const fullySettled = isTerminalToolStatus(state.status) && (world.has(entity, ToolResultConsumed) || consumedThisPass.has(entity));
    return !fullySettled;
  });
}
