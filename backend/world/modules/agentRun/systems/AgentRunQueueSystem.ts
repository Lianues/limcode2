import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { AgentRun, AgentRunNeedsModel, AgentRunQueueHold, AgentRunQueuedInput, AgentRunQueueOrder, AgentRunSourceLink, AgentRunTargetLink } from '../components';
import { AgentRunBundle, markRunNeedsModel, spawnMessageRunLink } from '../bundles';
import { Checkpoint, CheckpointBarrier } from '../../checkpoint/components';
import { CheckpointEventType } from '../../checkpoint/events';
import { Conversation, LlmRequest, Message, PartOf } from '../../chat/components';
import { UserMessageBundle } from '../../chat/bundles';
import { materializeUserInputMessage } from '../../chat/userInputMaterialization';

const QueuedRunsQuery = defineQuery({
  name: 'QueuedAgentRunsWithoutModelRequest',
  all: [AgentRun, AgentRunTargetLink],
  none: [AgentRunNeedsModel],
  read: [AgentRun, AgentRunTargetLink, AgentRunQueueHold, AgentRunQueuedInput, AgentRunQueueOrder, AgentRunSourceLink, AgentRunNeedsModel, LlmRequest, Conversation, Message, PartOf, Checkpoint, CheckpointBarrier],
  add: [AgentRunNeedsModel],
  write: [AgentRunSourceLink],
  remove: [AgentRunQueuedInput],
  mutationMode: 'update',
  role: 'work'
});

export const AgentRunQueueSystem = defineSystem({
  name: 'AgentRunQueueSystem',
  access: {
    queries: [QueuedRunsQuery],
    writes: { components: [CheckpointBarrier], mutationMode: 'create' },
    events: { emit: [CheckpointEventType.Requested] },
    bundles: [UserMessageBundle, AgentRunBundle]
  },
  run({ world, cmd }) {
    const queued = world
      .query(AgentRun)
      .filter((run) => world.get(run, AgentRun)?.status === 'queued' && !hasQueueHold(world, run) && !world.has(run, AgentRunNeedsModel) && !hasActiveRequest(world, run))
      .sort((a, b) => compareRunsByQueueOrder(world, a, b));

    const activatedConversations = new Set<Entity>();
    for (const run of queued) {
      const target = targetForRun(world, run);
      if (!target || activatedConversations.has(target.conversation)) continue;
      if (hasEarlierActiveRunInConversation(world, run, target.conversation)) continue;
      materializeQueuedInputForRun(world, cmd, run);
      markRunNeedsModel(cmd, run);
      activatedConversations.add(target.conversation);
    }
  }
});

function materializeQueuedInputForRun(world: WorldReader, cmd: CommandSink, run: Entity): void {
  const queuedInputEntity = world.query(AgentRunQueuedInput).find((entity) => world.get(entity, AgentRunQueuedInput)?.run === run);
  if (queuedInputEntity === undefined) return;
  const queuedInput = world.get(queuedInputEntity, AgentRunQueuedInput);
  if (!queuedInput) return;
  const conversation = world.get(queuedInput.conversation, Conversation);
  if (!conversation) return;

  const message = materializeUserInputMessage(world, cmd, queuedInput.conversation, conversation.id, queuedInput.content);
  spawnMessageRunLink(cmd, { message, run, role: 'input' });
  updateRunSourceMessage(world, cmd, run, queuedInput.conversation, message);
  cmd.remove(queuedInputEntity, AgentRunQueuedInput);
}

function updateRunSourceMessage(world: WorldReader, cmd: CommandSink, run: Entity, conversation: Entity, message: Entity): void {
  const sourceEntity = world.query(AgentRunSourceLink).find((entity) => world.get(entity, AgentRunSourceLink)?.run === run);
  if (sourceEntity === undefined) return;
  const source = world.get(sourceEntity, AgentRunSourceLink);
  if (!source) return;
  cmd.add(sourceEntity, AgentRunSourceLink, { ...source, sourceConversation: conversation, sourceMessage: message, updatedAt: Date.now() });
}

function hasEarlierActiveRunInConversation(world: WorldReader, run: Entity, conversation: Entity): boolean {
  const current = world.get(run, AgentRun);
  if (!current) return true;
  return world.query(AgentRun).some((candidate) => {
    if (candidate === run) return false;
    const data = world.get(candidate, AgentRun);
    const target = targetForRun(world, candidate);
    if (!data || !target || target.conversation !== conversation || isTerminalRunStatus(data.status)) return false;
    if (data.status === 'queued' && hasQueueHold(world, candidate)) return false;
    if (data.status !== 'queued') return true;
    return compareRunsByQueueOrder(world, candidate, run) < 0;
  });
}

function compareRunsByQueueOrder(world: WorldReader, left: Entity, right: Entity): number {
  const leftKey = queueSortKey(world, left);
  const rightKey = queueSortKey(world, right);
  return leftKey.order - rightKey.order || leftKey.createdAt - rightKey.createdAt || left - right;
}

function queueSortKey(world: WorldReader, run: Entity): { order: number; createdAt: number } {
  const data = world.get(run, AgentRun);
  const order = world
    .query(AgentRunQueueOrder)
    .map((entity) => world.get(entity, AgentRunQueueOrder))
    .find((candidate) => candidate?.run === run);
  const createdAt = data?.createdAt ?? 0;
  return { order: order?.order ?? createdAt, createdAt };
}

function hasQueueHold(world: WorldReader, run: Entity): boolean {
  return world.query(AgentRunQueueHold).some((entity) => world.get(entity, AgentRunQueueHold)?.run === run);
}

function hasActiveRequest(world: WorldReader, run: Entity): boolean {
  return world.query(LlmRequest).some((request) => world.get(request, LlmRequest)?.run === run);
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
