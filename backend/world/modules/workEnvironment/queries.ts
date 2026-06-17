import type { Entity, WorldReader } from '../../../ecs/types';
import type {
  WorkEnvironmentPolicyRecord,
  WorkEnvironmentPolicyScopeKind,
  WorkEnvironmentRecord
} from '../../../../shared/protocol';
import { Agent } from '../agent/components';
import { AgentRun, AgentRunTargetLink } from '../agentRun/components';
import { activeModeForRun, activeModeSelectionForConversation, runTarget } from '../agentRun/queries';
import { Conversation } from '../chat/components';
import { Mode } from '../mode/components';
import { ConversationProjectLink, ProjectContext } from '../project/components';
import {
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink,
  type WorkEnvironmentData,
  type WorkEnvironmentPolicyData,
  type WorkEnvironmentPolicyScopeLinkData
} from './components';

export interface ResolvedWorkEnvironment {
  entity: Entity;
  data: WorkEnvironmentData;
}

export interface WorkEnvironmentPolicyResolution {
  policy?: WorkEnvironmentPolicyData;
  policyEntity?: Entity;
  link?: WorkEnvironmentPolicyScopeLinkData;
  inheritedFrom?: WorkEnvironmentPolicyScopeKind | 'fallback';
}

export function toWorkEnvironmentRecord(data: WorkEnvironmentData, options: { includeSensitive?: boolean } = {}): WorkEnvironmentRecord {
  const includeSensitive = options.includeSensitive !== false;
  return {
    id: data.id,
    kind: data.kind,
    name: data.name,
    ...(data.uri ? { uri: data.uri } : {}),
    ...(data.rootPath ? { rootPath: data.rootPath } : {}),
    ...(data.displayPath ? { displayPath: data.displayPath } : {}),
    ...(data.source ? { source: data.source } : {}),
    ...(data.host ? { host: data.host } : {}),
    ...(data.port !== undefined ? { port: data.port } : {}),
    ...(data.user ? { user: data.user } : {}),
    ...(data.identityFile ? { identityFile: data.identityFile } : {}),
    ...(includeSensitive && data.password !== undefined ? { password: data.password } : {}),
    ...(data.workdir ? { workdir: data.workdir } : {}),
    ...(data.os ? { os: data.os } : {}),
    ...(data.description ? { description: data.description } : {}),
    ...(data.index !== undefined ? { index: data.index } : {}),
    available: data.available,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

export function toPublicWorkEnvironmentRecord(data: WorkEnvironmentData): WorkEnvironmentRecord {
  return toWorkEnvironmentRecord(data, { includeSensitive: false });
}

export function toWorkEnvironmentPolicyRecord(data: WorkEnvironmentPolicyData): WorkEnvironmentPolicyRecord {
  return {
    id: data.id,
    name: data.name,
    allowedWorkEnvironmentIds: [...data.allowedWorkEnvironmentIds],
    ...(data.defaultWorkEnvironmentId ? { defaultWorkEnvironmentId: data.defaultWorkEnvironmentId } : {}),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

export function availableWorkEnvironments(world: WorldReader): ResolvedWorkEnvironment[] {
  return world
    .query(WorkEnvironment)
    .map((entity) => {
      const data = world.get(entity, WorkEnvironment);
      return data?.available ? { entity, data } : undefined;
    })
    .filter((item): item is ResolvedWorkEnvironment => item !== undefined)
    .sort(compareResolvedWorkEnvironments);
}

export function allowedWorkEnvironmentsForConversation(world: WorldReader, conversation: Entity): ResolvedWorkEnvironment[] {
  return allowedWorkEnvironmentsForResolution(world, effectiveWorkEnvironmentPolicyForConversation(world, conversation));
}

export function allowedWorkEnvironmentsForRun(world: WorldReader, run: Entity): ResolvedWorkEnvironment[] {
  return allowedWorkEnvironmentsForResolution(world, effectiveWorkEnvironmentPolicyForRun(world, run));
}

export function defaultWorkEnvironment(world: WorldReader): ResolvedWorkEnvironment | undefined {
  return availableWorkEnvironments(world)[0];
}

export function activeWorkEnvironmentForConversation(world: WorldReader, conversation: Entity): ResolvedWorkEnvironment | undefined {
  const allowed = allowedWorkEnvironmentsForConversation(world, conversation);
  const allowedIds = new Set(allowed.map((item) => item.data.id));
  const linked = linkedWorkEnvironmentForConversation(world, conversation);
  if (linked?.data.available && allowedIds.has(linked.data.id)) return linked;

  const project = projectWorkEnvironmentForConversation(world, conversation);
  if (project && allowedIds.has(project.data.id)) return project;

  const policy = effectiveWorkEnvironmentPolicyForConversation(world, conversation).policy;
  const defaultByPolicy = policy?.defaultWorkEnvironmentId
    ? allowed.find((item) => item.data.id === policy.defaultWorkEnvironmentId)
    : undefined;
  return defaultByPolicy ?? allowed[0] ?? defaultWorkEnvironment(world);
}

export function activeWorkEnvironmentForRun(world: WorldReader, run: Entity): ResolvedWorkEnvironment | undefined {
  const allowed = allowedWorkEnvironmentsForRun(world, run);
  const allowedIds = new Set(allowed.map((item) => item.data.id));
  const linked = linkedWorkEnvironmentForRun(world, run);
  if (linked?.data.available && allowedIds.has(linked.data.id)) return linked;

  const target = runTargetConversation(world, run);
  const conversationActive = target !== undefined ? activeWorkEnvironmentForConversation(world, target) : undefined;
  if (conversationActive && allowedIds.has(conversationActive.data.id)) return conversationActive;

  const policy = effectiveWorkEnvironmentPolicyForRun(world, run).policy;
  const defaultByPolicy = policy?.defaultWorkEnvironmentId
    ? allowed.find((item) => item.data.id === policy.defaultWorkEnvironmentId)
    : undefined;
  return defaultByPolicy ?? allowed[0] ?? conversationActive ?? defaultWorkEnvironment(world);
}

export function linkedWorkEnvironmentForConversation(world: WorldReader, conversation: Entity): ResolvedWorkEnvironment | undefined {
  for (const entity of world.query(ConversationWorkEnvironmentLink)) {
    const link = world.get(entity, ConversationWorkEnvironmentLink);
    if (!link || link.conversation !== conversation || link.role !== 'active') continue;
    const data = world.get(link.workEnvironment, WorkEnvironment);
    if (data) return { entity: link.workEnvironment, data };
  }
  return undefined;
}

export function linkedWorkEnvironmentForRun(world: WorldReader, run: Entity): ResolvedWorkEnvironment | undefined {
  for (const entity of world.query(RunWorkEnvironmentLink)) {
    const link = world.get(entity, RunWorkEnvironmentLink);
    if (!link || link.run !== run || link.role !== 'active') continue;
    const data = world.get(link.workEnvironment, WorkEnvironment);
    if (data) return { entity: link.workEnvironment, data };
  }
  return undefined;
}

export function projectWorkEnvironmentForConversation(world: WorldReader, conversation: Entity): ResolvedWorkEnvironment | undefined {
  const project = projectContextForConversation(world, conversation);
  if (!project?.uri) return undefined;
  return availableWorkEnvironments(world).find((candidate) => candidate.data.kind === 'localFolder' && candidate.data.uri === project.uri);
}

export function runTargetConversation(world: WorldReader, run: Entity): Entity | undefined {
  return world
    .query(AgentRunTargetLink)
    .map((entity) => world.get(entity, AgentRunTargetLink))
    .find((link) => link?.run === run && link.role === 'executor')?.conversation;
}

export function findAvailableWorkEnvironmentById(world: WorldReader, id: string): ResolvedWorkEnvironment | undefined {
  return availableWorkEnvironments(world).find((candidate) => candidate.data.id === id);
}

export function resolveWorkEnvironmentBySelector(
  world: WorldReader,
  selector: { workEnvironmentId?: string; id?: string; name?: string },
  context: { run?: Entity; conversation?: Entity } = {}
): ResolvedWorkEnvironment | undefined {
  const environments = context.run !== undefined
    ? allowedWorkEnvironmentsForRun(world, context.run)
    : context.conversation !== undefined
      ? allowedWorkEnvironmentsForConversation(world, context.conversation)
      : availableWorkEnvironments(world);
  const requestedId = selector.workEnvironmentId?.trim() || selector.id?.trim();
  if (requestedId) {
    const byId = environments.find((candidate) => candidate.data.id === requestedId);
    if (byId) return byId;
    const byPath = environments.find((candidate) => candidate.data.uri === requestedId || candidate.data.rootPath === requestedId || candidate.data.displayPath === requestedId || candidate.data.host === requestedId);
    if (byPath) return byPath;
  }

  const requestedName = selector.name?.trim().toLowerCase();
  if (requestedName) {
    return environments.find((candidate) => candidate.data.name.toLowerCase() === requestedName)
      ?? environments.find((candidate) => candidate.data.name.toLowerCase().includes(requestedName));
  }

  return undefined;
}

export function effectiveWorkEnvironmentPolicyForConversation(world: WorldReader, conversation: Entity): WorkEnvironmentPolicyResolution {
  const selectedMode = activeModeSelectionForConversation(world, conversation);
  if (selectedMode?.scopeKind === 'mode') {
    const modePolicy = localPolicyForScopeEntity(world, 'mode', selectedMode.mode);
    if (modePolicy.policy) return { ...modePolicy, inheritedFrom: 'mode' };
  }

  const local = localPolicyForScopeEntity(world, 'conversation', conversation);
  if (local.policy) return local;

  const global = localPolicyForScope(world, 'global');
  if (global.policy) return { ...global, inheritedFrom: 'global' };

  return fallbackPolicy(world);
}

export function effectiveWorkEnvironmentPolicyForRun(world: WorldReader, run: Entity): WorkEnvironmentPolicyResolution {
  const runLocal = localPolicyForScopeEntity(world, 'run', run);
  if (runLocal.policy) return runLocal;

  const mode = activeModeForRun(world, run);
  if (mode !== undefined) {
    const modePolicy = localPolicyForScopeEntity(world, 'mode', mode);
    if (modePolicy.policy) return { ...modePolicy, inheritedFrom: 'mode' };
  }

  const target = runTarget(world, run);
  if (target) {
    const conversationPolicy = localPolicyForScopeEntity(world, 'conversation', target.conversation);
    if (conversationPolicy.policy) return { ...conversationPolicy, inheritedFrom: 'conversation' };
    const agentPolicy = localPolicyForScopeEntity(world, 'agent', target.agent);
    if (agentPolicy.policy) return { ...agentPolicy, inheritedFrom: 'agent' };
  }

  const global = localPolicyForScope(world, 'global');
  if (global.policy) return { ...global, inheritedFrom: 'global' };

  return fallbackPolicy(world);
}

export function localPolicyForScope(world: WorldReader, scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): WorkEnvironmentPolicyResolution {
  const normalizedScopeId = scopeKind === 'global' ? undefined : scopeId?.trim();
  const matches = world
    .query(WorkEnvironmentPolicyScopeLink)
    .map((entity) => ({ entity, link: world.get(entity, WorkEnvironmentPolicyScopeLink) }))
    .filter((item): item is { entity: Entity; link: WorkEnvironmentPolicyScopeLinkData } => !!item.link && item.link.role === 'active' && item.link.scopeKind === scopeKind && (scopeKind === 'global' ? item.link.scopeId === undefined : item.link.scopeId === normalizedScopeId))
    .sort((left, right) => right.link.updatedAt - left.link.updatedAt || right.link.createdAt - left.link.createdAt || right.entity - left.entity);
  const selected = matches[0];
  const policy = selected ? world.get(selected.link.policy, WorkEnvironmentPolicy) : undefined;
  return {
    ...(policy ? { policy, policyEntity: selected?.link.policy } : {}),
    ...(selected?.link ? { link: selected.link } : {})
  };
}

export function formatWorkEnvironmentContext(world: WorldReader, run: Entity): string | undefined {
  const environments = allowedWorkEnvironmentsForRun(world, run);
  if (environments.length === 0) return undefined;

  const current = activeWorkEnvironmentForRun(world, run) ?? environments[0];
  const lines = [
    '[工作环境 / WorkEnvironment]',
    `当前工作环境: ${formatWorkEnvironmentLine(current.data)}`,
    '可用工作环境:'
  ];
  for (const item of environments.slice(0, 12)) {
    lines.push(`- ${formatWorkEnvironmentLine(item.data)}`);
  }
  lines.push('如果需要切换 read_file、shell/bash 等工具使用的相对路径根目录，请先调用 switch_work_environment。切换后工具参数仍然使用相对路径 / 相对 cwd。远程服务器环境当前只支持识别与切换，远程工具执行暂未接入。');
  return lines.join('\n');
}

function localPolicyForScopeEntity(world: WorldReader, scopeKind: WorkEnvironmentPolicyScopeKind, scopeEntity: Entity | undefined): WorkEnvironmentPolicyResolution {
  if (scopeEntity === undefined) return {};
  return localPolicyForScope(world, scopeKind, scopeIdForEntity(world, scopeKind, scopeEntity));
}

function scopeIdForEntity(world: WorldReader, scopeKind: WorkEnvironmentPolicyScopeKind, entity: Entity): string | undefined {
  switch (scopeKind) {
    case 'conversation': return world.get(entity, Conversation)?.id;
    case 'agent': return world.get(entity, Agent)?.id;
    case 'mode': return world.get(entity, Mode)?.id;
    case 'run': return world.get(entity, AgentRun)?.id;
    case 'agentSystem': return undefined;
    case 'global': return undefined;
  }
}

function fallbackPolicy(world: WorldReader): WorkEnvironmentPolicyResolution {
  const now = Date.now();
  const ids = availableWorkEnvironments(world).map((item) => item.data.id);
  return ids.length > 0
    ? { policy: { id: 'work-environment-policy:fallback', name: '默认工作环境策略', allowedWorkEnvironmentIds: ids, defaultWorkEnvironmentId: ids[0], createdAt: now, updatedAt: now }, inheritedFrom: 'fallback' }
    : { inheritedFrom: 'fallback' };
}

function allowedWorkEnvironmentsForResolution(world: WorldReader, resolution: WorkEnvironmentPolicyResolution): ResolvedWorkEnvironment[] {
  const all = availableWorkEnvironments(world);
  const allowedIds = resolution.policy?.allowedWorkEnvironmentIds;
  if (!allowedIds || allowedIds.length === 0) return all;
  const allowed = new Set(allowedIds);
  return all.filter((item) => allowed.has(item.data.id));
}

function projectContextForConversation(world: WorldReader, conversation: Entity): ProjectContextDataLike | undefined {
  for (const entity of world.query(ConversationProjectLink)) {
    const link = world.get(entity, ConversationProjectLink);
    if (!link || link.conversation !== conversation || link.role !== 'primary') continue;
    return world.get(link.projectContext, ProjectContext);
  }
  return undefined;
}

interface ProjectContextDataLike {
  uri: string;
}

function compareResolvedWorkEnvironments(left: ResolvedWorkEnvironment, right: ResolvedWorkEnvironment): number {
  return workEnvironmentSortKey(left.data).localeCompare(workEnvironmentSortKey(right.data), 'zh-CN') || left.data.id.localeCompare(right.data.id);
}

function workEnvironmentSortKey(data: WorkEnvironmentData): string {
  const index = data.index === undefined ? '999999' : String(data.index).padStart(6, '0');
  const kind = data.kind === 'localFolder' ? '0' : '1';
  return `${kind}:${index}:${data.name}`;
}

function formatWorkEnvironmentLine(data: WorkEnvironmentData): string {
  const kindLabel = data.kind === 'localFolder' ? '本地' : '远程';
  if (data.kind === 'remoteServer') {
    const userPart = data.user ? `${data.user}@` : '';
    const host = data.host ?? data.name;
    const port = data.port && data.port !== 22 ? `:${data.port}` : '';
    const workdir = data.workdir ? ` · ${data.workdir}` : '';
    const os = data.os ? ` · ${data.os}` : '';
    const description = data.description ? ` · ${data.description}` : '';
    return `${data.id} · ${data.name} · ${kindLabel} · ${userPart}${host}${port}${workdir}${os}${description}`;
  }
  const path = data.displayPath ?? data.rootPath ?? data.uri ?? '';
  return `${data.id} · ${data.name} · ${kindLabel}${path ? ` · ${path}` : ''}`;
}
