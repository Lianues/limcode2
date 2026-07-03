import type { ComponentType, Entity, WorldReader } from '../../../ecs/types';
import type { ConfigScopeKind, ToolPolicyScopeKind, ToolPolicySourceConfigRecord, ToolPolicyToolConfigRecord } from '../../../../shared/protocol';
import { Agent, AgentConversationLink, AgentKind, ConversationAgentSelection, type ConversationAgentSelectionData } from '../agent/components';
import {
  ConversationModeSelection,
  type ConversationModeSelectionData,
  Mode,
  ModelProfile,
  ModelProfileScopeLink,
  type ModelProfileScopeLinkData,
  SystemPrompt,
  SystemPromptScopeLink,
  type SystemPromptScopeLinkData,
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
  return activeAgentForConversation(world, conversation);
}

export function activeAgentForConversation(world: WorldReader, conversation: Entity): Entity | undefined {
  const selection = latestSelectionForConversation(world, conversation);
  if (selection !== undefined) return selection.agent;
  const links = world
    .query(AgentConversationLink)
    .map((entity) => world.get(entity, AgentConversationLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.conversation === conversation);
  return links.find((link) => link.role === 'default')?.agent ?? links[0]?.agent;
}

function latestSelectionForConversation(world: WorldReader, conversation: Entity): { agent: Entity } | undefined {
  let selected: { entity: Entity; data: ConversationAgentSelectionData } | undefined;
  for (const entity of world.query(ConversationAgentSelection)) {
    const data = world.get(entity, ConversationAgentSelection);
    if (!data || data.role !== 'active' || data.conversation !== conversation) continue;
    if (!selected || isNewerRunPolicyLink(entity, data, selected.entity, selected.data)) selected = { entity, data };
  }
  return selected ? { agent: selected.data.agent } : undefined;
}

export function findConversationById(world: WorldReader, conversationId: string): Entity | undefined {
  return world.query(Conversation).find((entity) => world.get(entity, Conversation)?.id === conversationId);
}

export function findAgentById(world: WorldReader, agentId: string): Entity | undefined {
  return world.query(Agent).find((entity) => world.get(entity, Agent)?.id === agentId);
}

export function findAgentByKind(world: WorldReader, kind: string): Entity | undefined {
  return world.query(Agent).find((entity) => world.get(entity, AgentKind)?.kind === kind || world.get(entity, Agent)?.id === kind);
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
  const conversationSelection = activeModeSelectionForConversation(world, target.conversation);
  if (conversationSelection?.scopeKind === 'global') return undefined;
  if (conversationSelection?.scopeKind === 'mode') return conversationSelection.mode;
  return undefined;
}

export function activeModeSelectionForConversation(world: WorldReader, conversation: Entity): { scopeKind: 'global' } | { scopeKind: 'mode'; mode: Entity } | undefined {
  let selected: { entity: Entity; data: ConversationModeSelectionData } | undefined;
  for (const entity of world.query(ConversationModeSelection)) {
    const data = world.get(entity, ConversationModeSelection);
    if (!data || data.role !== 'active' || data.conversation !== conversation) continue;
    if (!selected || isNewerRunPolicyLink(entity, data, selected.entity, selected.data)) selected = { entity, data };
  }
  if (!selected) return undefined;
  if (selected.data.scopeKind === 'global') return { scopeKind: 'global' };
  return selected.data.mode !== undefined ? { scopeKind: 'mode', mode: selected.data.mode } : undefined;
}

export function activeModeForAgent(_world: WorldReader, _agent: Entity): Entity | undefined {
  return undefined;
}

export function systemPromptsForRun(world: WorldReader, run: Entity): SystemPromptData[] {
  const target = runTarget(world, run);
  const mode = activeModeForRun(world, run);
  const scopes: ScopeEntity[] = [
    { kind: 'global' },
    ...(target ? [{ kind: 'agent' as const, entity: target.agent }] : []),
    ...(mode !== undefined ? [{ kind: 'mode' as const, entity: mode }] : []),
    ...(target ? [{ kind: 'conversation' as const, entity: target.conversation }] : []),
    { kind: 'run', entity: run }
  ];

  const prompts: SystemPromptData[] = [];
  for (const scope of scopes) {
    for (const link of activeSystemPromptLinksForScope(world, scope)) {
      const prompt = world.get(link.systemPrompt, SystemPrompt);
      if (prompt?.text.trim()) prompts.push(prompt);
    }
  }

  const runLink = world
    .query(RunSystemPromptLink)
    .map((entity) => world.get(entity, RunSystemPromptLink))
    .find((candidate) => candidate?.run === run && candidate.role === 'active');
  const runPrompt = runLink ? world.get(runLink.systemPrompt, SystemPrompt) : undefined;
  if (runPrompt?.text.trim()) prompts.push(runPrompt);
  return prompts;
}

export function activeSystemPromptForRun(world: WorldReader, run: Entity): SystemPromptData | undefined {
  const prompts = systemPromptsForRun(world, run);
  if (prompts.length === 0) return undefined;
  return {
    id: `effective-system-prompt:${run}`,
    name: 'Effective System Prompt',
    text: prompts.map((prompt) => prompt.text.trim()).filter(Boolean).join('\n\n')
  };
}

export function activeModelProfileForRun(world: WorldReader, run: Entity): ModelProfileData | undefined {
  const runLink = world
    .query(RunModelProfileLink)
    .map((entity) => world.get(entity, RunModelProfileLink))
    .find((candidate) => candidate?.run === run && candidate.role === 'active');
  if (runLink) return world.get(runLink.modelProfile, ModelProfile);

  const target = runTarget(world, run);
  const mode = activeModeForRun(world, run);
  const scopes: ScopeEntity[] = [
    { kind: 'run', entity: run },
    ...(target ? [{ kind: 'conversation' as const, entity: target.conversation }] : []),
    ...(mode !== undefined ? [{ kind: 'mode' as const, entity: mode }] : []),
    ...(target ? [{ kind: 'agent' as const, entity: target.agent }] : []),
    { kind: 'global' }
  ];
  for (const scope of scopes) {
    const link = activeModelProfileLinkForScope(world, scope);
    const profile = link ? world.get(link.modelProfile, ModelProfile) : undefined;
    if (profile) return profile;
  }
  return undefined;
}

export function activeToolPolicyForRun(world: WorldReader, run: Entity): ToolPolicyData | undefined {
  const target = runTarget(world, run);
  const mode = activeModeForRun(world, run);
  const policies: ToolPolicyData[] = [];
  const push = (policy: ToolPolicyData | undefined): void => { if (policy) policies.push(policy); };

  push(activeToolPolicyForScopeEntity(world, 'global'));
  if (target) push(activeToolPolicyForScopeEntity(world, 'agent', target.agent));
  if (mode !== undefined) push(activeToolPolicyForScopeEntity(world, 'mode', mode));
  if (target) push(activeToolPolicyForScopeEntity(world, 'conversation', target.conversation));
  push(activeToolPolicyForScopeEntity(world, 'run', run));

  const runLink = world
    .query(RunToolPolicyLink)
    .map((entity) => world.get(entity, RunToolPolicyLink))
    .find((candidate) => candidate?.run === run && candidate.role === 'active');
  if (runLink) push(world.get(runLink.toolPolicy, ToolPolicy));

  if (policies.length === 0) return undefined;
  return intersectToolPolicies(policies, `effective-tool-policy:${run}`);
}

export function activeToolPolicyForScope(world: WorldReader, scopeKind: ToolPolicyScopeKind, scopeId?: string): ToolPolicyData | undefined {
  const scopeEntity = scopeKind === 'global' || scopeKind === 'agentSystem' ? undefined : entityForToolPolicyScope(world, scopeKind, scopeId);
  return activeToolPolicyForScopeEntity(world, scopeKind, scopeEntity, scopeId);
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

type ScopeEntity = { kind: ConfigScopeKind; entity?: Entity };

function activeSystemPromptLinksForScope(world: WorldReader, scope: ScopeEntity): SystemPromptScopeLinkData[] {
  const links: Array<{ entity: Entity; link: SystemPromptScopeLinkData }> = [];
  for (const entity of world.query(SystemPromptScopeLink)) {
    const link = world.get(entity, SystemPromptScopeLink);
    if (!link || link.role !== 'active' || !matchesConfigScope(world, link, scope)) continue;
    links.push({ entity, link });
  }
  links.sort((a, b) => (a.link.order ?? 0) - (b.link.order ?? 0) || (a.link.updatedAt || a.link.createdAt) - (b.link.updatedAt || b.link.createdAt) || a.entity - b.entity);
  return links.map((item) => item.link);
}

function activeModelProfileLinkForScope(world: WorldReader, scope: ScopeEntity): ModelProfileScopeLinkData | undefined {
  let selected: { entity: Entity; link: ModelProfileScopeLinkData } | undefined;
  for (const entity of world.query(ModelProfileScopeLink)) {
    const link = world.get(entity, ModelProfileScopeLink);
    if (!link || link.role !== 'active' || !matchesConfigScope(world, link, scope)) continue;
    if (!selected || isNewerRunPolicyLink(entity, link, selected.entity, selected.link)) selected = { entity, link };
  }
  return selected?.link;
}

function matchesConfigScope(world: WorldReader, link: { scopeKind: ConfigScopeKind; scopeId?: string; agent?: Entity; mode?: Entity; conversation?: Entity; run?: Entity }, scope: ScopeEntity): boolean {
  if (link.scopeKind !== scope.kind) return false;
  if (scope.kind === 'global') return true;
  if (scope.entity === undefined) return false;
  switch (scope.kind) {
    case 'agent': return link.agent === scope.entity || link.scopeId === world.get(scope.entity, Agent)?.id;
    case 'mode': return link.mode === scope.entity || link.scopeId === world.get(scope.entity, Mode)?.id;
    case 'conversation': return link.conversation === scope.entity || link.scopeId === world.get(scope.entity, Conversation)?.id;
    case 'run': return link.run === scope.entity || link.scopeId === world.get(scope.entity, AgentRun)?.id;
  }
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
      case 'mode': return link.mode === scopeEntity || link.scopeId === world.get(scopeEntity, Mode)?.id;
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
    case 'mode': return findRecordEntity(world, Mode, scopeId);
    case 'run': return findRecordEntity(world, AgentRun, scopeId);
    case 'global':
    case 'agentSystem':
      return undefined;
  }
}

function findRecordEntity<T extends { id: string }>(world: WorldReader, component: ComponentType<T>, id: string): Entity | undefined {
  return world.query(component).find((entity) => world.get(entity, component)?.id === id);
}

function intersectToolPolicies(policies: ToolPolicyData[], id: string): ToolPolicyData {
  const preset = policies.some((policy) => policy.preset === 'yolo') ? 'yolo' : undefined;
  let allowed = new Set(policies[0]?.allowedTools ?? []);
  for (const policy of policies.slice(1)) {
    const next = new Set(policy.allowedTools);
    allowed = new Set([...allowed].filter((tool) => next.has(tool)));
  }

  const toolConfigs: Record<string, ToolPolicyToolConfigRecord> = {};
  const sourceConfigs: Record<string, ToolPolicySourceConfigRecord> = {};
  for (const policy of policies) {
    for (const [sourceId, sourceConfig] of Object.entries(policy.sourceConfigs ?? {})) {
      const previous = sourceConfigs[sourceId];
      sourceConfigs[sourceId] = {
        enabled: previous?.enabled === false || sourceConfig.enabled === false ? false : sourceConfig.enabled || previous?.enabled === true,
        disabledTools: [...new Set([...(previous?.disabledTools ?? []), ...(sourceConfig.disabledTools ?? [])])]
      };
    }
    for (const [toolName, config] of Object.entries(policy.toolConfigs ?? {})) {
      const previous = toolConfigs[toolName];
      toolConfigs[toolName] = {
        config: { ...(previous?.config ?? {}), ...(config.config ?? {}) },
        autoApproveExecution: previous?.autoApproveExecution === false || config.autoApproveExecution === false ? false : config.autoApproveExecution ?? previous?.autoApproveExecution,
        autoApplyChange: previous?.autoApplyChange === false || config.autoApplyChange === false ? false : config.autoApplyChange ?? previous?.autoApplyChange,
        autoApplyChangeDelaySeconds: config.autoApplyChangeDelaySeconds ?? previous?.autoApplyChangeDelaySeconds,
        autoSubmitResult: previous?.autoSubmitResult === false || config.autoSubmitResult === false ? false : config.autoSubmitResult ?? previous?.autoSubmitResult,
        ...(config.display || previous?.display ? { display: { ...(previous?.display ?? {}), ...(config.display ?? {}) } } : {})
      };
    }
  }

  for (const toolName of preset === 'yolo' ? [] : Object.keys(toolConfigs)) {
    if (!allowed.has(toolName)) delete toolConfigs[toolName];
  }

  return {
    id,
    name: 'Effective Tool Policy',
    allowedTools: [...allowed],
    ...(preset ? { preset } : {}),
    ...(Object.keys(toolConfigs).length > 0 ? { toolConfigs } : {}),
    ...(Object.keys(sourceConfigs).length > 0 ? { sourceConfigs } : {})
  };
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
