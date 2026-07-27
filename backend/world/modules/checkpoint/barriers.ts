import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import type { CheckpointTriggerKind } from '../../../../shared/protocol';
import type { CheckpointRequestedPayload } from './events';
import { CheckpointEventType } from './events';
import { evaluateCheckpointRequestPolicy } from './queries';
import {
  CheckpointBarrier,
  type CheckpointBarrierData,
  type CheckpointBarrierReleaseReason,
  type CheckpointBarrierTargetKind
} from './components';

export interface SpawnCheckpointBarrierInput {
  checkpointId: string;
  conversation?: Entity;
  trigger: CheckpointTriggerKind;
  targetKind: CheckpointBarrierTargetKind;
  targetRun?: Entity;
  targetRunId?: string;
  targetToolCall?: Entity;
  targetToolCallId?: string;
  targetMessage?: Entity;
  targetMessageId?: string;
  targetLlmRequest?: Entity;
  targetLlmRequestId?: string;
}

export interface RequestCheckpointBarrierInput {
  barrier: SpawnCheckpointBarrierInput & { conversation: Entity };
  request: Omit<CheckpointRequestedPayload, 'checkpointId' | 'trigger'>;
  toolName?: string;
}

export type RequestCheckpointBarrierResult =
  | { requested: true; checkpointId: string; barrier: Entity }
  | { requested: false; reason: 'policy_disabled' | 'trigger_disabled' };

/** 原子地执行有效策略前置检查；关闭时既不创建 barrier，也不发送 Requested 事件。 */
export function requestCheckpointBarrierIfEnabled(
  world: WorldReader,
  cmd: CommandSink,
  input: RequestCheckpointBarrierInput
): RequestCheckpointBarrierResult {
  const evaluation = evaluateCheckpointRequestPolicy(world, {
    conversation: input.barrier.conversation,
    ...(input.barrier.targetRun !== undefined ? { run: input.barrier.targetRun } : {}),
    trigger: input.barrier.trigger,
    ...(input.toolName ? { toolName: input.toolName } : {})
  });
  if (!evaluation.enabled) return { requested: false, reason: evaluation.reason };

  const barrier = spawnCheckpointBarrier(cmd, input.barrier);
  cmd.enqueue({
    type: CheckpointEventType.Requested,
    payload: {
      ...input.request,
      checkpointId: input.barrier.checkpointId,
      trigger: input.barrier.trigger
    }
  });
  return { requested: true, checkpointId: input.barrier.checkpointId, barrier };
}

export function spawnCheckpointBarrier(cmd: CommandSink, input: SpawnCheckpointBarrierInput): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, CheckpointBarrier, {
    id: checkpointBarrierId(input.checkpointId),
    checkpointId: input.checkpointId,
    ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    trigger: input.trigger,
    status: 'waiting',
    targetKind: input.targetKind,
    ...(input.targetRun !== undefined ? { targetRun: input.targetRun } : {}),
    ...(input.targetRunId ? { targetRunId: input.targetRunId } : {}),
    ...(input.targetToolCall !== undefined ? { targetToolCall: input.targetToolCall } : {}),
    ...(input.targetToolCallId ? { targetToolCallId: input.targetToolCallId } : {}),
    ...(input.targetMessage !== undefined ? { targetMessage: input.targetMessage } : {}),
    ...(input.targetMessageId ? { targetMessageId: input.targetMessageId } : {}),
    ...(input.targetLlmRequest !== undefined ? { targetLlmRequest: input.targetLlmRequest } : {}),
    ...(input.targetLlmRequestId ? { targetLlmRequestId: input.targetLlmRequestId } : {}),
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function markCheckpointBarrierPending(world: WorldReader, cmd: CommandSink, checkpointId: string, checkpoint: Entity): void {
  for (const entity of checkpointBarrierEntitiesByCheckpointId(world, checkpointId)) {
    const barrier = world.get(entity, CheckpointBarrier);
    if (!barrier || barrier.status === 'released') continue;
    cmd.add(entity, CheckpointBarrier, { ...barrier, checkpoint, status: 'pending', updatedAt: Date.now() });
  }
}

export function releaseCheckpointBarriers(world: WorldReader, cmd: CommandSink, checkpointId: string, reason: CheckpointBarrierReleaseReason): void {
  for (const entity of checkpointBarrierEntitiesByCheckpointId(world, checkpointId)) {
    const barrier = world.get(entity, CheckpointBarrier);
    if (!barrier || barrier.status === 'released') continue;
    const now = Date.now();
    cmd.add(entity, CheckpointBarrier, {
      ...barrier,
      status: 'released',
      releaseReason: reason,
      releasedAt: now,
      updatedAt: now
    });
  }
}

export function consumeReleasedCheckpointBarrier(cmd: CommandSink, entity: Entity): void {
  cmd.despawn(entity);
}

export function checkpointBarrierId(checkpointId: string): string {
  return `checkpoint-barrier:${checkpointId}`;
}

function checkpointBarrierEntitiesByCheckpointId(world: WorldReader, checkpointId: string): Entity[] {
  return world.query(CheckpointBarrier).filter((entity) => world.get(entity, CheckpointBarrier)?.checkpointId === checkpointId);
}

export function newestBarrierForTarget(
  world: WorldReader,
  predicate: (barrier: CheckpointBarrierData) => boolean
): { entity: Entity; barrier: CheckpointBarrierData } | undefined {
  return world
    .query(CheckpointBarrier)
    .map((entity) => ({ entity, barrier: world.get(entity, CheckpointBarrier) }))
    .filter((item): item is { entity: Entity; barrier: CheckpointBarrierData } => !!item.barrier && predicate(item.barrier))
    .sort((left, right) => right.barrier.createdAt - left.barrier.createdAt || right.entity - left.entity)[0];
}
