import type { ComponentType, Entity, WorldReader } from '../../../ecs/types';
import type { ToolPolicyScopeKind } from '../../../../shared/protocol';
import { Agent, AgentConversationLink } from '../agent/components';
import {
  AgentMode,
  AgentModeLink,
  ModeModelProfileLink,
  ModeSystemPromptLink,
  ModeToolPolicyLink,
  ModelProfile,
  SystemPrompt,
  ToolPolicy,
  type ModelProfileData,
  type SystemPromptData,
  type ToolPolicyData
} from '../mode/components';
import { Conversation, Message, PartOf } from '../chat/components';
import { ToolCall } from '../tools/components';
import { ToolPolicyScopeLink, type ToolPolicyScopeLinkData } from '../tools/components';
import {
  AgentRun,
  AgentRunSourceLink,
  type AgentRunSourceLinkData,
  AgentRunTargetLink,
  MessageRunLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunDeliveryPolicy,
  RunDeliveryPolicyLink,
  RunEditPolicy,
  RunEditPolicyLink,
  RunModelProfileLink,
  RunModeLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  ToolCallRunLink,
  type RunContextPolicyData,
  type RunDeliveryPolicyData,
  type RunEditPolicyData
} from './components';

export function defaultAgentForConversation(world: WorldReader, conversation: Entity): Entity | undefined {
  const links = world
    .query(AgentConversationLink)
    .map((entity) => world.get(entity, AgentConversationLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.conversation === conversation);
  return links.find((link) => link.role === 'default')?.agent ?? links[0]?.agent;
}

export function findConversationById(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}

export function findAgentById(world: WorldReader, agentId: string): Entity | undefined {
  return world.query(Agent).find((entity) => world.get(entity, Agent)?.id === agentId);
}

export function findAgentByKind(world: WorldReader, kind: string): Entity | undefined {
  return world.query(Agent).find((entity) => world.get(entity, Agent)?.id === kind || world.get(entity, Agent)?.name === kind);
}

export function runTarget(world: WorldReader, run: Entity): { agent: Entity; conversation: Entity } | undefined {
  const link = world
    .query(AgentRunTargetLink)
    .map((entity) => world.get(entity, AgentRunTargetLink))
    .find((candidate) => candidate?.run === run && candidate.role === 'executor');
  return link ? { agent: link.agent, conversation: link.conversation } : undefined;
}

export function runSource(world: WorldReader, run: Entity): AgentRunSourceLinkData | undefined {
  return world
    .query(AgentRunSourceLink)
    .map((entity) => world.get(entity, AgentRunSourceLink))
    .find((candidate) => candidate?.run === run);
}

export function runForToolCall(world: WorldReader, toolCall: Entity): Entity | undefined {
  const link = world
    .query(ToolCallRunLink)
    .map((entity) => world.get(entity, ToolCallRunLink))
    .find((candidate) => candidate?.toolCall === toolCall);
  return link?.run;
}

export function toolCallEntityById(world: WorldReader, toolCallId: string): Entity | undefined {
  return world.query(ToolCall).find((entity) => world.get(entity, ToolCall)?.id === toolCallId);
}

export function messageConversation(world: WorldReader, message: Entity): Entity | undefined {
  return world.get(message, PartOf)?.parent;
}

export function runFinalModelText(world: WorldReader, run: Entity): string {
  const messages = world
    .query(Message, MessageRunLink)
    .filter((entity) => world.get(entity, MessageRunLink)?.run === run && world.get(entity, MessageRunLink)?.role === 'model')
    .map((entity) => world.get(entity, Message))
    .filter((message): message is NonNullable<typeof message> => !!message)
    .sort((a, b) => a.seq - b.seq);
  const last = messages[messages.length - 1];
  return last?.content.parts.map((part) => 'text' in part && part.thought !== true ? part.text : '').join('').trim() ?? '';
}

export function activeModeForRun(world: WorldReader, run: Entity): Entity | undefined {
  const runMode = world
    .query(RunModeLink)
    .map((entity) => world.get(entity, RunModeLink))
    .find((candidate) => candidate?.run === run && candidate.role === 'active')?.mode;
  if (runMode !== undefined) return runMode;

  const target = runTarget(world, run);
  if (!target) return undefined;
  return activeModeForAgent(world, target.agent);
}

export function activeModeForAgent(world: WorldReader, agent: Entity): Entity | undefined {
  const links = world
    .query(AgentModeLink)
    .map((entity) => world.get(entity, AgentModeLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.agent === agent);

  return links.find((link) => link.role === 'active')?.mode
    ?? links.find((link) => link.role === 'default')?.mode
    ?? links[0]?.mode;
}

export function activeToolPolicyForRun(world: WorldReader, run: Entity): ToolPolicyData | undefined {
  const runScopePolicy = activeToolPolicyForScopeEntity(world, 'run', run);
  if (runScopePolicy) return runScopePolicy;

  const runLink = world
    .query(RunToolPolicyLink)
    .map((entity) => world.get(entity, RunToolPolicyLink))
    .find((candidate) => candidate?.run === run && candidate.role === 'active');
  if (runLink) return world.get(runLink.toolPolicy, ToolPolicy);

  const target = runTarget(world, run);
  if (target) {
    const conversationScopePolicy = activeToolPolicyForScopeEntity(world, 'conversation', target.conversation);
    if (conversationScopePolicy) return conversationScopePolicy;

    const agentScopePolicy = activeToolPolicyForScopeEntity(world, 'agent', target.agent);
    if (agentScopePolicy) return agentScopePolicy;
  }

  const mode = activeModeForRun(world, run);
  if (mode !== undefined) {
    const modeScopePolicy = activeToolPolicyForScopeEntity(world, 'mode', mode);
    if (modeScopePolicy) return modeScopePolicy;
    const modePolicy = activeToolPolicyForMode(world, mode);
    if (modePolicy) return modePolicy;
  }

  return activeToolPolicyForScopeEntity(world, 'global');
}

export function activeToolPolicyForScope(world: WorldReader, scopeKind: ToolPolicyScopeKind, scopeId?: string): ToolPolicyData | undefined {
  const scopeEntity = scopeKind === 'global' || scopeKind === 'agentSystem' ? undefined : entityForToolPolicyScope(world, scopeKind, scopeId);
  return activeToolPolicyForScopeEntity(world, scopeKind, scopeEntity, scopeId);
}

export function activeSystemPromptForRun(world: WorldReader, run: Entity): SystemPromptData | undefined {
  const runLink = world
    .query(RunSystemPromptLink)
    .map((entity) => world.get(entity, RunSystemPromptLink))
    .find((candidate) => candidate?.run === run && candidate.role === 'active');
  if (runLink) return world.get(runLink.systemPrompt, SystemPrompt);
  const mode = activeModeForRun(world, run);
  return mode === undefined ? undefined : activeSystemPromptForMode(world, mode);
}

export function activeModelProfileForRun(world: WorldReader, run: Entity): ModelProfileData | undefined {
  const runLink = world
    .query(RunModelProfileLink)
    .map((entity) => world.get(entity, RunModelProfileLink))
    .find((candidate) => candidate?.run === run && candidate.role === 'active');
  if (runLink) return world.get(runLink.modelProfile, ModelProfile);
  const mode = activeModeForRun(world, run);
  return mode === undefined ? undefined : activeModelProfileForMode(world, mode);
}

export function activeContextPolicyForRun(world: WorldReader, run: Entity): RunContextPolicyData | undefined {
  const link = latestActiveRunPolicyLink(world, run, RunContextPolicyLink);
  return link ? world.get(link.policy, RunContextPolicy) : undefined;
}

export function activeDeliveryPolicyForRun(world: WorldReader, run: Entity): RunDeliveryPolicyData | undefined {
  const link = latestActiveRunPolicyLink(world, run, RunDeliveryPolicyLink);
  return link ? world.get(link.policy, RunDeliveryPolicy) : undefined;
}

export function activeEditPolicyForRun(world: WorldReader, run: Entity): RunEditPolicyData | undefined {
  const link = latestActiveRunPolicyLink(world, run, RunEditPolicyLink);
  return link ? world.get(link.policy, RunEditPolicy) : undefined;
}

export function effectiveEditPolicyForRun(world: WorldReader, run: Entity): RunEditPolicyData {
  return activeEditPolicyForRun(world, run) ?? { id: 'default-edit-policy', onSourceEdited: 'mark_stale', onNewUserMessageWhileRunning: 'queue_next_run' };
}

function latestActiveRunPolicyLink<T extends { run: Entity; policy: Entity; role: 'active'; createdAt: number; updatedAt: number }>(
  world: WorldReader,
  run: Entity,
  component: ComponentType<T>
): T | undefined {
  let selected: { entity: Entity; link: T } | undefined;
  for (const entity of world.query(component)) {
    const link = world.get(entity, component);
    if (!link || link.run !== run || link.role !== 'active') continue;
    if (!selected || isNewerRunPolicyLink(entity, link, selected.entity, selected.link)) {
      selected = { entity, link };
    }
  }
  return selected?.link;
}

function isNewerRunPolicyLink<T extends { createdAt: number; updatedAt: number }>(
  entity: Entity,
  link: T,
  previousEntity: Entity,
  previous: T
): boolean {
  const timestamp = link.updatedAt || link.createdAt;
  const previousTimestamp = previous.updatedAt || previous.createdAt;
  return timestamp > previousTimestamp || (timestamp === previousTimestamp && entity > previousEntity);
}
function activeToolPolicyForScopeEntity(
  world: WorldReader,
  scopeKind: ToolPolicyScopeKind,
  scopeEntity?: Entity,
  explicitScopeId?: string
): ToolPolicyData | undefined {
  let selected: { entity: Entity; link: ToolPolicyScopeLinkData } | undefined;
  for (const entity of world.query(ToolPolicyScopeLink)) {
    const link = world.get(entity, ToolPolicyScopeLink);
    if (!link || link.role !== 'active' || link.scopeKind !== scopeKind) continue;
    if (!matchesToolPolicyScope(world, link, scopeKind, scopeEntity, explicitScopeId)) continue;
    if (!selected || isNewerRunPolicyLink(entity, link, selected.entity, selected.link)) selected = { entity, link };
  }
  return selected ? world.get(selected.link.toolPolicy, ToolPolicy) : undefined;
}

function matchesToolPolicyScope(
  world: WorldReader,
  link: ToolPolicyScopeLinkData,
  scopeKind: ToolPolicyScopeKind,
  scopeEntity?: Entity,
  explicitScopeId?: string
): boolean {
  if (scopeKind === 'global') return true;
  if (scopeKind === 'agentSystem') return !!explicitScopeId && (link.scopeId === explicitScopeId || link.agentSystemId === explicitScopeId);
  if (scopeEntity !== undefined) {
    switch (scopeKind) {
      case 'conversation': return link.conversation === scopeEntity || link.scopeId === world.get(scopeEntity, Conversation)?.id;
      case 'agent': return link.agent === scopeEntity || link.scopeId === world.get(scopeEntity, Agent)?.id;
      case 'mode': return link.mode === scopeEntity || link.scopeId === world.get(scopeEntity, AgentMode)?.id;
      case 'run': return link.run === scopeEntity || link.scopeId === world.get(scopeEntity, AgentRun)?.id;
    }
  }
  return !!explicitScopeId && link.scopeId === explicitScopeId;
}

function entityForToolPolicyScope(world: WorldReader, scopeKind: ToolPolicyScopeKind, scopeId: string | undefined): Entity | undefined {
  if (!scopeId) return undefined;
  switch (scopeKind) {
    case 'conversation': return findRecordEntity(world, Conversation, scopeId);
    case 'agent': return findRecordEntity(world, Agent, scopeId);
    case 'mode': return findRecordEntity(world, AgentMode, scopeId);
    case 'run': return findRecordEntity(world, AgentRun, scopeId);
    case 'global':
    case 'agentSystem':
      return undefined;
  }
}

function findRecordEntity<T extends { id: string }>(world: WorldReader, component: ComponentType<T>, id: string): Entity | undefined {
  return world.query(component).find((entity) => world.get(entity, component)?.id === id);
}



function activeToolPolicyForMode(world: WorldReader, mode: Entity): ToolPolicyData | undefined {
  const link = world
    .query(ModeToolPolicyLink)
    .map((entity) => world.get(entity, ModeToolPolicyLink))
    .find((candidate) => candidate?.mode === mode && candidate.role === 'active');
  return link ? world.get(link.toolPolicy, ToolPolicy) : undefined;
}

function activeSystemPromptForMode(world: WorldReader, mode: Entity): SystemPromptData | undefined {
  const link = world
    .query(ModeSystemPromptLink)
    .map((entity) => world.get(entity, ModeSystemPromptLink))
    .find((candidate) => candidate?.mode === mode && candidate.role === 'active');
  return link ? world.get(link.systemPrompt, SystemPrompt) : undefined;
}

function activeModelProfileForMode(world: WorldReader, mode: Entity): ModelProfileData | undefined {
  const link = world
    .query(ModeModelProfileLink)
    .map((entity) => world.get(entity, ModeModelProfileLink))
    .find((candidate) => candidate?.mode === mode && candidate.role === 'active');
  return link ? world.get(link.modelProfile, ModelProfile) : undefined;
}

export function hasRun(world: WorldReader, run: Entity): boolean {
  return world.has(run, AgentRun);
}

export interface AgentRunTreeNode {
  run: Entity;
  children: AgentRunTreeNode[];
}

export function parentRunForRun(world: WorldReader, run: Entity): Entity | undefined {
  return world
    .query(AgentRunSourceLink)
    .map((entity) => world.get(entity, AgentRunSourceLink))
    .find((candidate) => candidate?.run === run)?.sourceRun;
}

export function childRunsForRun(world: WorldReader, run: Entity): Entity[] {
  return world
    .query(AgentRunSourceLink)
    .map((entity) => world.get(entity, AgentRunSourceLink))
    .filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate && candidate.sourceRun === run)
    .map((link) => link.run)
    .filter((child) => world.has(child, AgentRun))
    .sort((a, b) => (world.get(a, AgentRun)?.createdAt ?? 0) - (world.get(b, AgentRun)?.createdAt ?? 0) || a - b);
}

export function runTree(world: WorldReader, root: Entity): AgentRunTreeNode {
  return { run: root, children: childRunsForRun(world, root).map((child) => runTree(world, child)) };
}
