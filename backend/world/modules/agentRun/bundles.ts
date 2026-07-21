import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import { createStableId } from '../../../utils/stableId';
import type { AgentRunKind, AgentRunQueueHoldReason, AgentRunSourceKind, DeliveryMode, MessageContent, TranscriptInclusion } from '../../../../shared/protocol';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunNeedsModel,
  AgentRunQueueHold,
  AgentRunQueueOrder,
  AgentRunQueuedInput,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageRunLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunConversationPolicy,
  RunConversationPolicyLink,
  RunDeliveryPolicy,
  RunDeliveryPolicyLink,
  RunEditPolicy,
  RunEditPolicyLink,
  ToolCallRunLink
} from './components';

export const AgentRunBundle = defineBundle({
  name: 'AgentRunBundle',
  writes: [
    AgentRun,
    AgentRunNeedsModel,
    AgentRunQueueHold,
    AgentRunQueueOrder,
    AgentRunQueuedInput,
    AgentRunSourceLink,
    AgentRunTargetLink,
    MessageRunLink,
    ToolCallRunLink,
    RunConversationPolicy,
    RunConversationPolicyLink,
    RunContextPolicy,
    RunContextPolicyLink,
    RunDeliveryPolicy,
    RunDeliveryPolicyLink,
    RunEditPolicy,
    RunEditPolicyLink,
    AgentRunInputRevision
  ],
  mutationMode: 'create',
  spawns: true
});

export interface SpawnAgentRunInput {
  id?: string;
  kind: AgentRunKind;
  agent: Entity;
  conversation: Entity;
  sourceKind: AgentRunSourceKind;
  sourceAgent?: Entity;
  sourceConversation?: Entity;
  sourceMessage?: Entity;
  sourceToolCall?: Entity;
  sourceRun?: Entity;
  answerBridgeId?: string;
  inputMessage?: Entity;
  deliveryMode?: DeliveryMode;
  includeTranscript?: TranscriptInclusion;
  retryOfRunId?: string;
  attempt?: number;
  needsModel?: boolean;
  queuedInputContent?: MessageContent;
  /** 初始 queue hold；持有期间不会附加 AgentRunNeedsModel，由队列系统在解除后启动。 */
  queueHoldReason?: AgentRunQueueHoldReason;
}

export function spawnAgentRun(cmd: CommandSink, input: SpawnAgentRunInput): Entity {
  const run = cmd.spawn();
  const now = Date.now();
  cmd.add(run, AgentRun, {
    id: input.id ?? createStableId('run'),
    kind: input.kind,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {})
  });
  if (input.needsModel !== false && input.queueHoldReason === undefined) {
    cmd.add(run, AgentRunNeedsModel, { since: now });
  }

  const queueOrder = cmd.spawn();
  cmd.add(queueOrder, AgentRunQueueOrder, {
    id: createStableId('arqo'),
    run,
    conversation: input.conversation,
    order: now,
    createdAt: now,
    updatedAt: now
  });

  if (input.queuedInputContent !== undefined) {
    const queuedInput = cmd.spawn();
    cmd.add(queuedInput, AgentRunQueuedInput, {
      id: createStableId('arqi'),
      run,
      conversation: input.conversation,
      content: input.queuedInputContent,
      createdAt: now,
      updatedAt: now
    });
  }

  if (input.queueHoldReason !== undefined) {
    const queueHold = cmd.spawn();
    cmd.add(queueHold, AgentRunQueueHold, {
      id: createStableId('arqh'),
      run,
      conversation: input.conversation,
      reason: input.queueHoldReason,
      createdAt: now,
      updatedAt: now
    });
  }

  const source = cmd.spawn();
  cmd.add(source, AgentRunSourceLink, {
    id: createStableId('ars'),
    run,
    sourceKind: input.sourceKind,
    ...(input.sourceAgent !== undefined ? { sourceAgent: input.sourceAgent } : {}),
    ...(input.sourceConversation !== undefined ? { sourceConversation: input.sourceConversation } : {}),
    ...(input.sourceMessage !== undefined ? { sourceMessage: input.sourceMessage } : {}),
    ...(input.sourceToolCall !== undefined ? { sourceToolCall: input.sourceToolCall } : {}),
    ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
    ...(input.answerBridgeId ? { answerBridgeId: input.answerBridgeId } : {}),
    createdAt: now,
    updatedAt: now
  });

  const target = cmd.spawn();
  cmd.add(target, AgentRunTargetLink, {
    id: createStableId('art'),
    run,
    agent: input.agent,
    conversation: input.conversation,
    role: 'executor',
    createdAt: now,
    updatedAt: now
  });

  if (input.inputMessage !== undefined) {
    spawnMessageRunLink(cmd, { message: input.inputMessage, run, role: 'input' });
  }

  spawnDefaultRunPolicies(cmd, run, input.deliveryMode ?? 'direct_reply', input.includeTranscript ?? 'summary');
  return run;
}

export function spawnMessageRunLink(cmd: CommandSink, input: { message: Entity; run: Entity; role: 'input' | 'model' | 'tool_response' | 'notification' }): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, MessageRunLink, { id: createStableId('mrl'), message: input.message, run: input.run, role: input.role, createdAt: now, updatedAt: now });
  return entity;
}

export function spawnToolCallRunLink(cmd: CommandSink, input: { toolCall: Entity; run: Entity }): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, ToolCallRunLink, { id: createStableId('tcrl'), toolCall: input.toolCall, run: input.run, role: 'produced_by', createdAt: now, updatedAt: now });
  return entity;
}

export function markRunNeedsModel(cmd: CommandSink, run: Entity): void {
  cmd.add(run, AgentRunNeedsModel, { since: Date.now() });
}

function spawnDefaultRunPolicies(cmd: CommandSink, run: Entity, deliveryMode: DeliveryMode, includeTranscript: TranscriptInclusion): void {
  const now = Date.now();

  const conversationPolicy = cmd.spawn();
  cmd.add(conversationPolicy, RunConversationPolicy, { id: createStableId('rcp'), mode: 'same_conversation', visibility: 'visible' });
  const conversationPolicyLink = cmd.spawn();
  cmd.add(conversationPolicyLink, RunConversationPolicyLink, { id: createStableId('rcpl'), run, policy: conversationPolicy, role: 'active', createdAt: now, updatedAt: now });

  const contextPolicy = cmd.spawn();
  cmd.add(contextPolicy, RunContextPolicy, { id: createStableId('rctx'), historyMode: 'full' });
  const contextPolicyLink = cmd.spawn();
  cmd.add(contextPolicyLink, RunContextPolicyLink, { id: createStableId('rctxl'), run, policy: contextPolicy, role: 'active', createdAt: now, updatedAt: now });

  const deliveryPolicy = cmd.spawn();
  cmd.add(deliveryPolicy, RunDeliveryPolicy, { id: createStableId('rdp'), mode: deliveryMode, includeTranscript });
  const deliveryPolicyLink = cmd.spawn();
  cmd.add(deliveryPolicyLink, RunDeliveryPolicyLink, { id: createStableId('rdpl'), run, policy: deliveryPolicy, role: 'active', createdAt: now, updatedAt: now });

  const editPolicy = cmd.spawn();
  cmd.add(editPolicy, RunEditPolicy, { id: createStableId('rep'), onSourceEdited: 'mark_stale', onNewUserMessageWhileRunning: 'queue_next_run' });
  const editPolicyLink = cmd.spawn();
  cmd.add(editPolicyLink, RunEditPolicyLink, { id: createStableId('repl'), run, policy: editPolicy, role: 'active', createdAt: now, updatedAt: now });
}
