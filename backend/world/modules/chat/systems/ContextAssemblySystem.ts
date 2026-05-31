import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
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
    writes: { components: [MessageRunLink] }
  },
  run({ world, cmd }) {
    for (const run of world.query(AgentRun, AgentRunNeedsModel)) {
      if (hasActiveRequest(world, run)) continue;
      const target = targetForRun(world, run);
      if (!target) continue;
      const modelMessage = spawnModelMessage(cmd, target.conversation);
      spawnMessageRunLink(cmd, { message: modelMessage, run, role: 'model' });
      spawnLlmRequest(cmd, { run, conversation: target.conversation, modelMessage });
      cmd.remove(run, AgentRunNeedsModel);
    }
  }
});

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
