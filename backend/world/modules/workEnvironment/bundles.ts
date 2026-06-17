import { defineBundle, type CommandSink, type Entity, type WorldReader } from '../../../ecs/types';
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
import type { LocalWorkEnvironmentCandidate } from './events';
import type { WorkEnvironmentPolicyScopeKind, WorkEnvironmentRecord } from '../../../../shared/protocol';

export const WorkEnvironmentBundle = defineBundle({
  name: 'WorkEnvironmentBundle',
  writes: [WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink, ConversationWorkEnvironmentLink, RunWorkEnvironmentLink],
  mutationMode: 'update',
  spawns: true,
  despawns: true
});

export function upsertLocalWorkEnvironment(
  world: WorldReader,
  cmd: CommandSink,
  candidate: LocalWorkEnvironmentCandidate
): Entity {
  return upsertWorkEnvironment(world, cmd, {
    id: candidate.id,
    kind: 'localFolder',
    source: 'workspaceFolder',
    name: candidate.name,
    uri: candidate.uri,
    rootPath: candidate.rootPath,
    displayPath: candidate.displayPath ?? candidate.rootPath,
    index: candidate.index,
    available: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}

export function upsertWorkEnvironment(world: WorldReader, cmd: CommandSink, record: WorkEnvironmentRecord): Entity {
  const now = Date.now();
  const existing = findWorkEnvironmentById(world, record.id);
  const previous = existing !== undefined ? world.get(existing, WorkEnvironment) : undefined;
  const next = normalizeWorkEnvironmentRecord(record, previous, now);

  if (existing !== undefined) {
    cmd.add(existing, WorkEnvironment, next);
    return existing;
  }

  const entity = cmd.spawn();
  cmd.add(entity, WorkEnvironment, next);
  return entity;
}

export function markMissingLocalWorkEnvironmentsUnavailable(
  world: WorldReader,
  cmd: CommandSink,
  activeIds: ReadonlySet<string>
): void {
  const now = Date.now();
  for (const entity of world.query(WorkEnvironment)) {
    const current = world.get(entity, WorkEnvironment);
    if (!current || current.kind !== 'localFolder' || activeIds.has(current.id) || !current.available) continue;
    const { index: _index, ...withoutIndex } = current;
    cmd.add(entity, WorkEnvironment, { ...withoutIndex, available: false, updatedAt: now });
  }
}

export function selectConversationWorkEnvironment(
  world: WorldReader,
  cmd: CommandSink,
  conversation: Entity,
  workEnvironment: Entity
): Entity | undefined {
  if (!world.has(workEnvironment, WorkEnvironment)) return undefined;

  const now = Date.now();
  let selected: Entity | undefined;
  for (const entity of world.query(ConversationWorkEnvironmentLink)) {
    const link = world.get(entity, ConversationWorkEnvironmentLink);
    if (!link || link.conversation !== conversation || link.role !== 'active') continue;
    if (selected === undefined) selected = entity;
    else cmd.despawn(entity);
  }

  if (selected !== undefined) {
    const current = world.get(selected, ConversationWorkEnvironmentLink)!;
    cmd.add(selected, ConversationWorkEnvironmentLink, {
      ...current,
      workEnvironment,
      updatedAt: now
    });
    return selected;
  }

  const entity = cmd.spawn();
  cmd.add(entity, ConversationWorkEnvironmentLink, {
    id: `cwel${entity}`,
    conversation,
    workEnvironment,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function selectRunWorkEnvironment(
  world: WorldReader,
  cmd: CommandSink,
  run: Entity,
  workEnvironment: Entity
): Entity | undefined {
  if (!world.has(workEnvironment, WorkEnvironment)) return undefined;

  const now = Date.now();
  let selected: Entity | undefined;
  for (const entity of world.query(RunWorkEnvironmentLink)) {
    const link = world.get(entity, RunWorkEnvironmentLink);
    if (!link || link.run !== run || link.role !== 'active') continue;
    if (selected === undefined) selected = entity;
    else cmd.despawn(entity);
  }

  if (selected !== undefined) {
    const current = world.get(selected, RunWorkEnvironmentLink)!;
    cmd.add(selected, RunWorkEnvironmentLink, {
      ...current,
      workEnvironment,
      updatedAt: now
    });
    return selected;
  }

  const entity = cmd.spawn();
  cmd.add(entity, RunWorkEnvironmentLink, {
    id: `rwel${entity}`,
    run,
    workEnvironment,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function upsertWorkEnvironmentPolicy(
  world: WorldReader,
  cmd: CommandSink,
  input: { id: string; name: string; allowedWorkEnvironmentIds: string[]; defaultWorkEnvironmentId?: string }
): Entity {
  const now = Date.now();
  const existing = findWorkEnvironmentPolicyById(world, input.id);
  const previous = existing !== undefined ? world.get(existing, WorkEnvironmentPolicy) : undefined;
  const allowedWorkEnvironmentIds = normalizeAllowedWorkEnvironmentIds(world, input.allowedWorkEnvironmentIds);
  const defaultWorkEnvironmentId = input.defaultWorkEnvironmentId && allowedWorkEnvironmentIds.includes(input.defaultWorkEnvironmentId)
    ? input.defaultWorkEnvironmentId
    : allowedWorkEnvironmentIds[0];
  const policy: WorkEnvironmentPolicyData = {
    id: input.id,
    name: input.name.trim() || '工作环境策略',
    allowedWorkEnvironmentIds,
    ...(defaultWorkEnvironmentId ? { defaultWorkEnvironmentId } : {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };

  if (existing !== undefined) {
    cmd.add(existing, WorkEnvironmentPolicy, policy);
    return existing;
  }

  const entity = cmd.spawn();
  cmd.add(entity, WorkEnvironmentPolicy, policy);
  return entity;
}

export function upsertWorkEnvironmentPolicyScopeLink(
  world: WorldReader,
  cmd: CommandSink,
  input: {
    scopeKind: WorkEnvironmentPolicyScopeKind;
    scopeId?: string;
    policy: Entity;
    data: Partial<{ conversation: Entity; agent: Entity; mode: Entity; run: Entity; agentSystemId: string }>;
  }
): Entity {
  const now = Date.now();
  const existing = findActivePolicyScopeLink(world, input.scopeKind, input.scopeId);
  if (existing) {
    cmd.add(existing.entity, WorkEnvironmentPolicyScopeLink, {
      ...existing.link,
      policy: input.policy,
      ...input.data,
      updatedAt: now
    });
    return existing.entity;
  }

  const entity = cmd.spawn();
  cmd.add(entity, WorkEnvironmentPolicyScopeLink, {
    id: workEnvironmentPolicyScopeLinkId(input.scopeKind, input.scopeId),
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    policy: input.policy,
    ...input.data,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function findWorkEnvironmentById(world: WorldReader, id: string): Entity | undefined {
  return world.query(WorkEnvironment).find((entity) => world.get(entity, WorkEnvironment)?.id === id);
}

export function findWorkEnvironmentPolicyById(world: WorldReader, id: string): Entity | undefined {
  return world.query(WorkEnvironmentPolicy).find((entity) => world.get(entity, WorkEnvironmentPolicy)?.id === id);
}

export function findActivePolicyScopeLink(world: WorldReader, scopeKind: WorkEnvironmentPolicyScopeKind, scopeId: string | undefined): { entity: Entity; link: WorkEnvironmentPolicyScopeLinkData } | undefined {
  const normalized = scopeKind === 'global' ? undefined : scopeId?.trim();
  const matches = world.query(WorkEnvironmentPolicyScopeLink)
    .map((entity) => ({ entity, link: world.get(entity, WorkEnvironmentPolicyScopeLink) }))
    .filter((item): item is { entity: Entity; link: WorkEnvironmentPolicyScopeLinkData } => !!item.link && item.link.role === 'active' && item.link.scopeKind === scopeKind && (scopeKind === 'global' ? item.link.scopeId === undefined : item.link.scopeId === normalized))
    .sort((left, right) => right.link.updatedAt - left.link.updatedAt || right.link.createdAt - left.link.createdAt || right.entity - left.entity);
  return matches[0];
}

export function workEnvironmentIdFromUri(uri: string): string {
  return `work-env-local-${shortHash(uri.trim())}`;
}

export function remoteWorkEnvironmentIdFromHost(host: string): string {
  return `work-env-remote-${shortHash(host.trim().toLowerCase())}`;
}

export function workEnvironmentPolicyIdForScope(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): string {
  return `work-environment-policy:${scopeKind}:${scopeKind === 'global' ? 'global' : scopeId ?? 'unknown'}`;
}

export function workEnvironmentPolicyScopeLinkId(scopeKind: WorkEnvironmentPolicyScopeKind, scopeId?: string): string {
  return `work-environment-policy-scope:${scopeKind}:${scopeKind === 'global' ? 'global' : scopeId ?? 'unknown'}`;
}

export function normalizeAllowedWorkEnvironmentIds(world: WorldReader, ids: readonly string[]): string[] {
  void world;
  const result: string[] = [];
  for (const id of ids) {
    const normalized = typeof id === 'string' ? id.trim() : '';
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
  }
  return result;
}

function normalizeWorkEnvironmentRecord(record: WorkEnvironmentRecord, previous: WorkEnvironmentData | undefined, now: number): WorkEnvironmentData {
  const kind = record.kind === 'remoteServer' ? 'remoteServer' : 'localFolder';
  const name = kind === 'remoteServer'
    ? normalizeString(record.name) || normalizeString(record.host) || previous?.name || '服务器环境'
    : normalizeString(record.name) || previous?.name || '工作环境';
  const host = normalizeString(record.host) || (kind === 'remoteServer' ? previous?.host || normalizeString(record.name) : undefined);
  const user = normalizeString(record.user);
  const port = normalizePort(record.port);
  const identityFile = normalizeString(record.identityFile);
  const password = identityFile ? undefined : typeof record.password === 'string' ? record.password : undefined;
  const workdir = normalizeString(record.workdir);
  const displayPath = normalizeString(record.displayPath) || (kind === 'remoteServer' ? remoteDisplayPath({ user, host, port, workdir }) : normalizeString(record.rootPath) || normalizeString(record.uri));

  return {
    id: normalizeString(record.id) || previous?.id || (kind === 'remoteServer' && host ? remoteWorkEnvironmentIdFromHost(host) : `work-env-${shortHash(`${name}:${now}`)}`),
    kind,
    name,
    ...(normalizeString(record.uri) ? { uri: normalizeString(record.uri) } : {}),
    ...(normalizeString(record.rootPath) ? { rootPath: normalizeString(record.rootPath) } : {}),
    ...(displayPath ? { displayPath } : {}),
    ...(record.source ? { source: record.source } : previous?.source ? { source: previous.source } : kind === 'remoteServer' ? { source: 'manual' as const } : { source: 'workspaceFolder' as const }),
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(user ? { user } : {}),
    ...(identityFile ? { identityFile } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(workdir ? { workdir } : {}),
    ...(normalizeString(record.os) ? { os: normalizeString(record.os) } : {}),
    ...(normalizeString(record.description) ? { description: normalizeString(record.description) } : {}),
    ...(record.index !== undefined ? { index: record.index } : previous?.index !== undefined ? { index: previous.index } : {}),
    available: record.available !== false,
    createdAt: previous?.createdAt ?? finiteTimestamp(record.createdAt, now),
    updatedAt: now
  };
}

function remoteDisplayPath(input: { user?: string; host?: string; port?: number; workdir?: string }): string | undefined {
  if (!input.host) return undefined;
  const userPart = input.user ? `${input.user}@` : '';
  const portPart = input.port && input.port !== 22 ? `:${input.port}` : '';
  const dirPart = input.workdir ? ` ${input.workdir}` : '';
  return `${userPart}${input.host}${portPart}${dirPart}`;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePort(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : undefined;
  return number !== undefined && Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function finiteTimestamp(value: unknown, fallback: number): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallback;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
