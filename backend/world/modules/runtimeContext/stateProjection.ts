import type {
  ClientState,
  ConversationRuntimeContextSnapshotLinkRecord,
  RuntimeContextRecord,
  RuntimeContextScopeLinkRecord,
  RuntimeContextSnapshotRecord,
  RunRuntimeContextSnapshotLinkRecord
} from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { AgentRun } from '../agentRun/components';
import { Conversation } from '../chat/components';
import { Workflow } from '../workflow/components';
import {
  ConversationRuntimeContextSnapshotLink,
  RuntimeContext,
  RuntimeContextScopeLink,
  RuntimeContextSnapshot,
  RunRuntimeContextSnapshotLink
} from './components';
import { PromptPlaceholdersKey } from './resources';

export const runtimeContextStateProjectionReads: AccessDeclaration = {
  components: [Agent, AgentRun, Conversation, Workflow, RuntimeContext, RuntimeContextScopeLink, RuntimeContextSnapshot, ConversationRuntimeContextSnapshotLink, RunRuntimeContextSnapshotLink],
  resources: [PromptPlaceholdersKey]
};

export function projectRuntimeContextState(world: WorldReader): Partial<ClientState> {
  const runtimeContexts: RuntimeContextRecord[] = world.query(RuntimeContext).map((entity) => ({ ...world.get(entity, RuntimeContext)! }));
  const runtimeContextScopeLinks = world.query(RuntimeContextScopeLink).map((entity) => buildScopeLinkRecord(world, entity)).filter(isDefined);
  const runtimeContextSnapshots = world.query(RuntimeContextSnapshot).map((entity) => buildSnapshotRecord(world, entity)).filter(isDefined);
  const conversationRuntimeContextSnapshotLinks = world.query(ConversationRuntimeContextSnapshotLink).map((entity) => buildConversationSnapshotLinkRecord(world, entity)).filter(isDefined);
  const runRuntimeContextSnapshotLinks = world.query(RunRuntimeContextSnapshotLink).map((entity) => buildRunSnapshotLinkRecord(world, entity)).filter(isDefined);
  return {
    promptPlaceholders: world.tryGetResource(PromptPlaceholdersKey) ?? [],
    runtimeContexts,
    runtimeContextScopeLinks,
    runtimeContextSnapshots,
    conversationRuntimeContextSnapshotLinks,
    runRuntimeContextSnapshotLinks
  };
}

function buildScopeLinkRecord(world: WorldReader, entity: number): RuntimeContextScopeLinkRecord | undefined {
  const link = world.get(entity, RuntimeContextScopeLink);
  if (!link) return undefined;
  const runtimeContext = world.get(link.runtimeContext, RuntimeContext);
  if (!runtimeContext) return undefined;
  const scopeId = scopeIdForLink(world, link);
  if (link.scopeKind !== 'global' && !scopeId) return undefined;
  return {
    id: link.id,
    scopeKind: link.scopeKind,
    ...(scopeId ? { scopeId } : {}),
    runtimeContextId: runtimeContext.id,
    role: link.role,
    ...(link.order !== undefined ? { order: link.order } : {}),
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function buildSnapshotRecord(world: WorldReader, entity: number): RuntimeContextSnapshotRecord | undefined {
  const snapshot = world.get(entity, RuntimeContextSnapshot);
  if (!snapshot) return undefined;
  const conversation = snapshot.conversation !== undefined ? world.get(snapshot.conversation, Conversation) : undefined;
  return {
    id: snapshot.id,
    name: snapshot.name,
    text: snapshot.text,
    template: snapshot.template,
    ...(conversation ? { conversationId: conversation.id } : {}),
    ...(snapshot.sourceRuntimeContexts && snapshot.sourceRuntimeContexts.length > 0 ? { sourceRuntimeContextIds: snapshot.sourceRuntimeContexts.map((item) => world.get(item, RuntimeContext)?.id).filter(isDefined) } : {}),
    ...(snapshot.sourceHash ? { sourceHash: snapshot.sourceHash } : {}),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    refreshedAt: snapshot.refreshedAt
  };
}

function buildConversationSnapshotLinkRecord(world: WorldReader, entity: number): ConversationRuntimeContextSnapshotLinkRecord | undefined {
  const link = world.get(entity, ConversationRuntimeContextSnapshotLink);
  if (!link) return undefined;
  const conversation = world.get(link.conversation, Conversation);
  const snapshot = world.get(link.snapshot, RuntimeContextSnapshot);
  if (!conversation || !snapshot) return undefined;
  return { id: link.id, conversationId: conversation.id, runtimeContextSnapshotId: snapshot.id, role: link.role, createdAt: link.createdAt, updatedAt: link.updatedAt };
}

function buildRunSnapshotLinkRecord(world: WorldReader, entity: number): RunRuntimeContextSnapshotLinkRecord | undefined {
  const link = world.get(entity, RunRuntimeContextSnapshotLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const snapshot = world.get(link.snapshot, RuntimeContextSnapshot);
  if (!run || !snapshot) return undefined;
  return { id: link.id, runId: run.id, runtimeContextSnapshotId: snapshot.id, role: link.role, createdAt: link.createdAt, updatedAt: link.updatedAt };
}

type ScopeLink = { scopeKind: string; scopeId?: string; agent?: number; workflow?: number; conversation?: number; run?: number };

function scopeIdForLink(world: WorldReader, link: ScopeLink): string | undefined {
  if (link.scopeKind === 'global') return undefined;
  if (link.scopeId) return link.scopeId;
  switch (link.scopeKind) {
    case 'agent': return link.agent !== undefined ? world.get(link.agent, Agent)?.id : undefined;
    case 'workflow': return link.workflow !== undefined ? world.get(link.workflow, Workflow)?.id : undefined;
    case 'conversation': return link.conversation !== undefined ? world.get(link.conversation, Conversation)?.id : undefined;
    case 'run': return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
    default: return undefined;
  }
}

function isDefined<T>(value: T | undefined): value is T { return value !== undefined; }
