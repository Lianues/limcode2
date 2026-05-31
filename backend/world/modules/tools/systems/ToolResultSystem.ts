import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { AgentRun, ToolCallRunLink } from '../../agentRun/components';
import { markRunNeedsModel, spawnMessageRunLink } from '../../agentRun/bundles';
import { runTarget } from '../../agentRun/queries';
import { PartOf } from '../../chat/components';
import { spawnToolResponseMessage, ToolResultMessageBundle } from '../../chat/bundles';
import { ToolCall, ToolResultConsumed, ToolState } from '../components';
import { isTerminalToolStatus, toolStateToResponse } from '../state';

const SettledToolCallsQuery = defineQuery({
  name: 'SettledToolCalls',
  all: [ToolCall, ToolState, ToolCallRunLink],
  none: [ToolResultConsumed],
  read: [ToolCall, ToolState, ToolCallRunLink, AgentRun],
  add: [ToolResultConsumed],
  mutationMode: 'consume',
  role: 'work'
});

const ActiveToolWorkLookupQuery = defineQuery({
  name: 'ActiveToolWorkLookup',
  all: [ToolCall, ToolState, ToolCallRunLink],
  read: [ToolCall, ToolState, ToolCallRunLink, ToolResultConsumed],
  role: 'lookup'
});

export const ToolResultSystem = defineSystem({
  name: 'ToolResultSystem',
  access: {
    queries: [SettledToolCallsQuery, ActiveToolWorkLookupQuery],
    bundles: [ToolResultMessageBundle],
    writes: { components: [AgentRun] }
  },
  run({ world, cmd }) {
    const settled = world
      .query(ToolCall, ToolState, ToolCallRunLink)
      .filter((entity) => {
        const state = world.get(entity, ToolState);
        return !!state && isTerminalToolStatus(state.status) && !world.has(entity, ToolResultConsumed);
      });
    if (settled.length === 0) return;

    const touchedRuns = new Set<Entity>();
    const consumedThisPass = new Set<Entity>();
    for (const entity of settled) {
      const call = world.get(entity, ToolCall);
      const state = world.get(entity, ToolState);
      const run = world.get(entity, ToolCallRunLink)?.run;
      if (!call || !state || run === undefined || !isTerminalToolStatus(state.status)) continue;
      const runData = world.get(run, AgentRun);
      if (!runData || isTerminalRunStatus(runData.status)) continue;
      const target = runTarget(world, run);
      if (!target) continue;

      const responseMessage = spawnToolResponseMessage(cmd, {
        conversation: target.conversation,
        toolCallId: call.functionCallId ?? call.id,
        toolName: call.name,
        status: state.status,
        response: toolStateToResponse(state),
        durationMs: state.durationMs
      });
      spawnMessageRunLink(cmd, { message: responseMessage, run, role: 'tool_response' });
      cmd.add(entity, ToolResultConsumed, true);
      consumedThisPass.add(entity);
      touchedRuns.add(run);
    }

    for (const run of touchedRuns) {
      if (!hasPendingToolWork(world, run, consumedThisPass)) {
        const runData = world.get(run, AgentRun);
        if (runData) {
          cmd.add(run, AgentRun, { ...runData, status: 'running', updatedAt: Date.now() });
        }
        markRunNeedsModel(cmd, run);
      }
    }
  }
});

function hasPendingToolWork(world: WorldReader, run: Entity, consumedThisPass: ReadonlySet<Entity>): boolean {
  return world.query(ToolCall, ToolState, ToolCallRunLink).some((entity) => {
    if (world.get(entity, ToolCallRunLink)?.run !== run) return false;
    const state = world.get(entity, ToolState);
    if (!state) return false;
    const fullySettled = isTerminalToolStatus(state.status) && (world.has(entity, ToolResultConsumed) || consumedThisPass.has(entity));
    return !fullySettled;
  });
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stale';
}
