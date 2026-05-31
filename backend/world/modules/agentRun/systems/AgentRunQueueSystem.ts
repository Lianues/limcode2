import { defineQuery, defineSystem, type Entity, type WorldReader } from '../../../../ecs/types';
import { AgentRun, AgentRunNeedsModel, AgentRunTargetLink } from '../components';
import { markRunNeedsModel } from '../bundles';

const QueuedRunsQuery = defineQuery({
  name: 'QueuedAgentRunsWithoutModelRequest',
  all: [AgentRun, AgentRunTargetLink],
  none: [AgentRunNeedsModel],
  read: [AgentRun, AgentRunTargetLink, AgentRunNeedsModel],
  add: [AgentRunNeedsModel],
  mutationMode: 'update',
  role: 'work'
});

export const AgentRunQueueSystem = defineSystem({
  name: 'AgentRunQueueSystem',
  access: {
    queries: [QueuedRunsQuery]
  },
  run({ world, cmd }) {
    const queued = world
      .query(AgentRun)
      .filter((run) => world.get(run, AgentRun)?.status === 'queued' && !world.has(run, AgentRunNeedsModel))
      .sort((a, b) => (world.get(a, AgentRun)?.createdAt ?? 0) - (world.get(b, AgentRun)?.createdAt ?? 0) || a - b);

    const activatedConversations = new Set<Entity>();
    for (const run of queued) {
      const target = targetForRun(world, run);
      if (!target || activatedConversations.has(target.conversation)) continue;
      if (hasEarlierActiveRunInConversation(world, run, target.conversation)) continue;
      markRunNeedsModel(cmd, run);
      activatedConversations.add(target.conversation);
    }
  }
});

function hasEarlierActiveRunInConversation(world: WorldReader, run: Entity, conversation: Entity): boolean {
  const current = world.get(run, AgentRun);
  if (!current) return true;
  return world.query(AgentRun).some((candidate) => {
    if (candidate === run) return false;
    const data = world.get(candidate, AgentRun);
    const target = targetForRun(world, candidate);
    if (!data || !target || target.conversation !== conversation || isTerminalRunStatus(data.status)) return false;
    return data.createdAt < current.createdAt || (data.createdAt === current.createdAt && candidate < run);
  });
}

function targetForRun(world: WorldReader, run: Entity): { conversation: Entity } | undefined {
  const link = world
    .query(AgentRunTargetLink)
    .map((entity) => world.get(entity, AgentRunTargetLink))
    .find((candidate) => candidate?.run === run && candidate.role === 'executor');
  return link ? { conversation: link.conversation } : undefined;
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stale';
}
