import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import type { AgentRunKind, AgentRunSourceKind, DeliveryMode, TranscriptInclusion } from '../../../../shared/protocol';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunNeedsModel,
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
  kind: AgentRunKind;
  agent: Entity;
  conversation: Entity;
  sourceKind: AgentRunSourceKind;
  sourceAgent?: Entity;
  sourceConversation?: Entity;
  sourceMessage?: Entity;
  sourceToolCall?: Entity;
  sourceRun?: Entity;
  inputMessage?: Entity;
  deliveryMode?: DeliveryMode;
  includeTranscript?: TranscriptInclusion;
  retryOfRunId?: string;
  attempt?: number;
  needsModel?: boolean;
}

export function spawnAgentRun(cmd: CommandSink, input: SpawnAgentRunInput): Entity {
  const run = cmd.spawn();
  const now = Date.now();
  cmd.add(run, AgentRun, {
    id: `run${run}`,
    kind: input.kind,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {})
  });
  if (input.needsModel !== false) cmd.add(run, AgentRunNeedsModel, { since: now });

  const source = cmd.spawn();
  cmd.add(source, AgentRunSourceLink, {
    id: `ars${source}`,
    run,
    sourceKind: input.sourceKind,
    ...(input.sourceAgent !== undefined ? { sourceAgent: input.sourceAgent } : {}),
    ...(input.sourceConversation !== undefined ? { sourceConversation: input.sourceConversation } : {}),
    ...(input.sourceMessage !== undefined ? { sourceMessage: input.sourceMessage } : {}),
    ...(input.sourceToolCall !== undefined ? { sourceToolCall: input.sourceToolCall } : {}),
    ...(input.sourceRun !== undefined ? { sourceRun: input.sourceRun } : {}),
    createdAt: now,
    updatedAt: now
  });

  const target = cmd.spawn();
  cmd.add(target, AgentRunTargetLink, {
    id: `art${target}`,
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
  cmd.add(entity, MessageRunLink, { id: `mrl${entity}`, message: input.message, run: input.run, role: input.role, createdAt: now, updatedAt: now });
  return entity;
}

export function spawnToolCallRunLink(cmd: CommandSink, input: { toolCall: Entity; run: Entity }): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, ToolCallRunLink, { id: `tcrl${entity}`, toolCall: input.toolCall, run: input.run, role: 'produced_by', createdAt: now, updatedAt: now });
  return entity;
}

export function markRunNeedsModel(cmd: CommandSink, run: Entity): void {
  cmd.add(run, AgentRunNeedsModel, { since: Date.now() });
}

function spawnDefaultRunPolicies(cmd: CommandSink, run: Entity, deliveryMode: DeliveryMode, includeTranscript: TranscriptInclusion): void {
  const now = Date.now();

  const conversationPolicy = cmd.spawn();
  cmd.add(conversationPolicy, RunConversationPolicy, { id: `rcp${conversationPolicy}`, mode: 'same_conversation', visibility: 'visible' });
  const conversationPolicyLink = cmd.spawn();
  cmd.add(conversationPolicyLink, RunConversationPolicyLink, { id: `rcpl${conversationPolicyLink}`, run, policy: conversationPolicy, role: 'active', createdAt: now, updatedAt: now });

  const contextPolicy = cmd.spawn();
  cmd.add(contextPolicy, RunContextPolicy, { id: `rctx${contextPolicy}`, historyMode: 'full' });
  const contextPolicyLink = cmd.spawn();
  cmd.add(contextPolicyLink, RunContextPolicyLink, { id: `rctxl${contextPolicyLink}`, run, policy: contextPolicy, role: 'active', createdAt: now, updatedAt: now });

  const deliveryPolicy = cmd.spawn();
  cmd.add(deliveryPolicy, RunDeliveryPolicy, { id: `rdp${deliveryPolicy}`, mode: deliveryMode, includeTranscript });
  const deliveryPolicyLink = cmd.spawn();
  cmd.add(deliveryPolicyLink, RunDeliveryPolicyLink, { id: `rdpl${deliveryPolicyLink}`, run, policy: deliveryPolicy, role: 'active', createdAt: now, updatedAt: now });

  const editPolicy = cmd.spawn();
  cmd.add(editPolicy, RunEditPolicy, { id: `rep${editPolicy}`, onSourceEdited: 'mark_stale', onNewUserMessageWhileRunning: 'queue_next_run' });
  const editPolicyLink = cmd.spawn();
  cmd.add(editPolicyLink, RunEditPolicyLink, { id: `repl${editPolicyLink}`, run, policy: editPolicy, role: 'active', createdAt: now, updatedAt: now });
}
