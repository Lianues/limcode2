import { defineBundle, type Entity, type World } from '../../../ecs/types';
import { Conversation } from '../chat/components';
import { ConversationProjectLink, ProjectContext } from './components';

export const ProjectContextBundle = defineBundle({ name: 'ProjectContextBundle', writes: [ProjectContext], mutationMode: 'create', spawns: true });
export const ConversationProjectLinkBundle = defineBundle({ name: 'ConversationProjectLinkBundle', writes: [ConversationProjectLink], mutationMode: 'create', spawns: true });

export interface EnsureProjectContextInput {
  uri: string;
  name?: string;
}

export interface SetConversationProjectInput extends EnsureProjectContextInput {
  conversation: Entity;
}

export function ensureProjectContext(world: World, input: EnsureProjectContextInput): Entity {
  const uri = normalizeProjectUri(input.uri);
  const existing = world.query(ProjectContext).find((entity) => world.get(entity, ProjectContext)?.uri === uri);
  const now = Date.now();
  const name = normalizeProjectName(input.name, uri);

  if (existing !== undefined) {
    const current = world.get(existing, ProjectContext)!;
    if (current.name !== name) {
      world.add(existing, ProjectContext, { ...current, name, updatedAt: now });
    }
    return existing;
  }

  const entity = world.spawn();
  world.add(entity, ProjectContext, {
    id: projectContextIdFromUri(uri),
    kind: 'folder',
    uri,
    name,
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

export function setConversationProject(world: World, input: SetConversationProjectInput): Entity | undefined {
  if (!world.has(input.conversation, Conversation)) return undefined;

  const projectContext = ensureProjectContext(world, input);
  const now = Date.now();
  let existingPrimary: Entity | undefined;

  for (const entity of world.query(ConversationProjectLink)) {
    const link = world.get(entity, ConversationProjectLink);
    if (!link || link.conversation !== input.conversation || link.role !== 'primary') continue;
    if (link.projectContext === projectContext) {
      world.add(entity, ConversationProjectLink, { ...link, updatedAt: now });
      return entity;
    }
    if (existingPrimary === undefined) existingPrimary = entity;
    else world.despawn(entity);
  }

  if (existingPrimary !== undefined) world.despawn(existingPrimary);

  const linkEntity = world.spawn();
  world.add(linkEntity, ConversationProjectLink, {
    id: `cpl-${linkEntity}`,
    conversation: input.conversation,
    projectContext,
    role: 'primary',
    createdAt: now,
    updatedAt: now
  });
  return linkEntity;
}

export function normalizeProjectUri(uri: string): string {
  return uri.trim();
}

export function projectContextIdFromUri(uri: string): string {
  return `project-${shortHash(normalizeProjectUri(uri))}`;
}

function normalizeProjectName(name: string | undefined, uri: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const withoutTrailingSlash = uri.replace(/[\\/]+$/g, '');
  const tail = withoutTrailingSlash.split(/[\\/]/).pop();
  return tail?.trim() || uri;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
