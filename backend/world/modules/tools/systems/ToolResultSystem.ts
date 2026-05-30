import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { NeedsResponse, PartOf } from '../../chat/components';
import { spawnToolResponseMessage, ToolResultMessageBundle } from '../../chat/bundles';
import { ToolCall, ToolCompleted, ToolFailed, ToolResult, ToolResultConsumed } from '../components';

const SettledToolCallsQuery = defineQuery({
  name: 'SettledToolCalls',
  all: [ToolCall],
  any: [ToolCompleted, ToolFailed],
  none: [ToolResultConsumed],
  read: [ToolCall, ToolResult, ToolCompleted, ToolFailed],
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

const PendingToolWorkLookupQuery = defineQuery({
  name: 'PendingToolWorkLookup',
  all: [ToolCall],
  read: [ToolCall, PartOf, ToolCompleted, ToolFailed, ToolResultConsumed],
  role: 'lookup'
});

export const ToolResultSystem = defineSystem({
  name: 'ToolResultSystem',
  worker: { modulePath: '../world/modules/tools/systems/ToolResultSystem', exportName: 'ToolResultSystem' },
  access: {
    queries: [SettledToolCallsQuery, ToolParentLookupQuery, PendingToolWorkLookupQuery],
    bundles: [ToolResultMessageBundle]
  },
  run({ world, cmd }) {
    const settled = world
      .query(ToolCall)
      .filter(
        (entity) =>
          (world.has(entity, ToolCompleted) || world.has(entity, ToolFailed)) &&
          !world.has(entity, ToolResultConsumed)
      );
    if (settled.length === 0) return;

    const touchedSessions = new Set<Entity>();
    for (const entity of settled) {
      const call = world.get(entity, ToolCall);
      const result = world.get(entity, ToolResult);
      const modelMessage = world.get(entity, PartOf)?.parent;
      if (!call || !result || modelMessage === undefined) continue;
      const session = world.get(modelMessage, PartOf)?.parent;
      if (session === undefined) continue;

      spawnToolResponseMessage(cmd, { session, toolCallId: call.functionCallId ?? call.id, toolName: call.name, ok: result.ok, output: result.output });
      cmd.add(entity, ToolResultConsumed, true);
      touchedSessions.add(session);
    }

    for (const session of touchedSessions) {
      if (!hasPendingToolWork(world, session)) cmd.add(session, NeedsResponse, { since: Date.now() });
    }
  }
});

function hasPendingToolWork(world: WorldReader, session: Entity): boolean {
  return world.query(ToolCall).some((entity) => {
    const modelMessage = world.get(entity, PartOf)?.parent;
    if (modelMessage === undefined) return false;
    if (world.get(modelMessage, PartOf)?.parent !== session) return false;
    const fullySettled =
      (world.has(entity, ToolCompleted) || world.has(entity, ToolFailed)) &&
      world.has(entity, ToolResultConsumed);
    return !fullySettled;
  });
}
