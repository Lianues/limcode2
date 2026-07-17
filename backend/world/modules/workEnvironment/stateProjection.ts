import type {
  ClientState,
  ConversationWorkEnvironmentLinkRecord,
  RunWorkEnvironmentLinkRecord,
  WorkEnvironmentPolicyRecord,
  WorkEnvironmentPolicyScopeLinkRecord,
  WorkEnvironmentRecord
} from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { AgentRun } from '../agentRun/components';
import { Conversation } from '../chat/components';
import { Workflow } from '../workflow/components';
import {
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink,
  type WorkEnvironmentPolicyScopeLinkData
} from './components';
import { toWorkEnvironmentPolicyRecord, toWorkEnvironmentRecord } from './queries';

export const workEnvironmentStateProjectionReads: AccessDeclaration = {
  components: [
    WorkEnvironment,
    WorkEnvironmentPolicy,
    WorkEnvironmentPolicyScopeLink,
    ConversationWorkEnvironmentLink,
    RunWorkEnvironmentLink,
    Conversation,
    Agent,
    Workflow,
    AgentRun
  ]
};

export function workEnvironmentStateProjection(world: WorldReader): Partial<ClientState> {
  const workEnvironments: WorkEnvironmentRecord[] = world
    .query(WorkEnvironment)
    .map((entity) => toWorkEnvironmentRecord(world.get(entity, WorkEnvironment)!, { includeSensitive: true }));

  const workEnvironmentPolicies: WorkEnvironmentPolicyRecord[] = world
    .query(WorkEnvironmentPolicy)
    .map((entity) => toWorkEnvironmentPolicyRecord(world.get(entity, WorkEnvironmentPolicy)!));

  const workEnvironmentPolicyScopeLinks: WorkEnvironmentPolicyScopeLinkRecord[] = world
    .query(WorkEnvironmentPolicyScopeLink)
    .map((entity) => buildWorkEnvironmentPolicyScopeLinkRecord(world, entity))
    .filter((item): item is WorkEnvironmentPolicyScopeLinkRecord => item !== undefined);

  const conversationWorkEnvironmentLinks: ConversationWorkEnvironmentLinkRecord[] = world
    .query(ConversationWorkEnvironmentLink)
    .map((entity) => buildConversationWorkEnvironmentLinkRecord(world, entity))
    .filter((item): item is ConversationWorkEnvironmentLinkRecord => item !== undefined);

  const runWorkEnvironmentLinks: RunWorkEnvironmentLinkRecord[] = world
    .query(RunWorkEnvironmentLink)
    .map((entity) => buildRunWorkEnvironmentLinkRecord(world, entity))
    .filter((item): item is RunWorkEnvironmentLinkRecord => item !== undefined);

  return { workEnvironments, workEnvironmentPolicies, workEnvironmentPolicyScopeLinks, conversationWorkEnvironmentLinks, runWorkEnvironmentLinks };
}

function buildWorkEnvironmentPolicyScopeLinkRecord(world: WorldReader, entity: number): WorkEnvironmentPolicyScopeLinkRecord | undefined {
  const link = world.get(entity, WorkEnvironmentPolicyScopeLink);
  if (!link) return undefined;
  const policy = world.get(link.policy, WorkEnvironmentPolicy);
  if (!policy) return undefined;
  const scopeId = link.scopeId ?? scopeIdForLink(world, link);
  if (link.scopeKind !== 'global' && !scopeId) return undefined;
  return {
    id: link.id,
    scopeKind: link.scopeKind,
    ...(scopeId ? { scopeId } : {}),
    workEnvironmentPolicyId: policy.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function buildConversationWorkEnvironmentLinkRecord(world: WorldReader, entity: number): ConversationWorkEnvironmentLinkRecord | undefined {
  const link = world.get(entity, ConversationWorkEnvironmentLink);
  if (!link) return undefined;
  const conversation = world.get(link.conversation, Conversation);
  const workEnvironment = world.get(link.workEnvironment, WorkEnvironment);
  if (!conversation || !workEnvironment) return undefined;
  return {
    id: link.id,
    conversationId: conversation.id,
    workEnvironmentId: workEnvironment.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function buildRunWorkEnvironmentLinkRecord(world: WorldReader, entity: number): RunWorkEnvironmentLinkRecord | undefined {
  const link = world.get(entity, RunWorkEnvironmentLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const workEnvironment = world.get(link.workEnvironment, WorkEnvironment);
  if (!run || !workEnvironment) return undefined;
  return {
    id: link.id,
    runId: run.id,
    workEnvironmentId: workEnvironment.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function scopeIdForLink(world: WorldReader, link: WorkEnvironmentPolicyScopeLinkData): string | undefined {
  if (link.scopeKind === 'global') return undefined;
  if (link.scopeId) return link.scopeId;
  switch (link.scopeKind) {
    case 'conversation': return link.conversation !== undefined ? world.get(link.conversation, Conversation)?.id : undefined;
    case 'agent': return link.agent !== undefined ? world.get(link.agent, Agent)?.id : undefined;
    case 'workflow': return link.workflow !== undefined ? world.get(link.workflow, Workflow)?.id : undefined;
    case 'run': return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
    case 'agentSystem': return link.agentSystemId;
  }
}
