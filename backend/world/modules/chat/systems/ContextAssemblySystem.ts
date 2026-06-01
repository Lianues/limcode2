import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { AgentRun, AgentRunNeedsModel, AgentRunTargetLink, MessageRunLink } from '../../agentRun/components';
import { spawnMessageRunLink } from '../../agentRun/bundles';
import { LlmRequest, Conversation } from '../components';
import { ModelMessageBundle, LlmRequestBundle, spawnModelMessage, spawnLlmRequest } from '../bundles';

const RunsNeedingModelQuery = defineQuery({
  name: 'RunsNeedingModel',
  all: [AgentRun, AgentRunNeedsModel],
  read: [AgentRun, AgentRunNeedsModel, AgentRunTargetLink, LlmRequest],
  remove: [AgentRunNeedsModel],
  mutationMode: 'consume',
  role: 'work'
});

const ActiveLlmRequestsQuery = defineQuery({
  name: 'ActiveLlmRequests',
  all: [LlmRequest],
  read: [LlmRequest],
  role: 'lookup'
});

export const ContextAssemblySystem = defineSystem({
  name: 'ContextAssemblySystem',
  access: {
    queries: [RunsNeedingModelQuery, ActiveLlmRequestsQuery],
    bundles: [ModelMessageBundle, LlmRequestBundle],
    writes: { components: [AgentRun, MessageRunLink] }
  },
  run({ world, cmd }) {
    for (const run of world.query(AgentRun, AgentRunNeedsModel)) {
      if (hasActiveRequest(world, run)) {
        cmd.remove(run, AgentRunNeedsModel);
        continue;
      }
      const target = targetForRun(world, run);
      if (!target) continue;
      const modelMessage = spawnModelMessage(cmd, target.conversation);
      spawnMessageRunLink(cmd, { message: modelMessage, run, role: 'model' });
      spawnLlmRequest(cmd, { run, conversation: target.conversation, modelMessage });
      markRunRunning(world, cmd, run);
      cmd.remove(run, AgentRunNeedsModel);
    }
  }
});

function markRunRunning(world: WorldReader, cmd: CommandSink, run: Entity): void {
  const data = world.get(run, AgentRun);
  if (!data || (data.status !== 'queued' && data.status !== 'preparing')) return;
  cmd.add(run, AgentRun, { ...data, status: 'running', updatedAt: Date.now() });
}

function hasActiveRequest(world: WorldReader, run: Entity): boolean {
  return world.query(LlmRequest).some((request) => world.get(request, LlmRequest)?.run === run);
}

function targetForRun(world: WorldReader, run: Entity): { conversation: Entity } | undefined {
  const link = world
    .query(AgentRunTargetLink)
    .map((entity) => world.get(entity, AgentRunTargetLink))
    .find((candidate) => candidate?.run === run && world.has(candidate.conversation, Conversation));
  return link ? { conversation: link.conversation } : undefined;
}
