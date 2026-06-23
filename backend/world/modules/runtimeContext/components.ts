import { defineComponent, type Entity } from '../../../ecs/types';
import type { ConfigScopeBindingRole, ConfigScopeKind } from '../../../../shared/protocol';

export interface RuntimeContextData {
  id: string;
  name: string;
  template: string;
}
export const RuntimeContext = defineComponent<RuntimeContextData>('RuntimeContext');

export interface RuntimeContextScopeLinkData {
  id: string;
  scopeKind: ConfigScopeKind;
  scopeId?: string;
  runtimeContext: Entity;
  agent?: Entity;
  mode?: Entity;
  conversation?: Entity;
  run?: Entity;
  role: ConfigScopeBindingRole;
  order?: number;
  createdAt: number;
  updatedAt: number;
}
export const RuntimeContextScopeLink = defineComponent<RuntimeContextScopeLinkData>('RuntimeContextScopeLink');

export interface RuntimeContextSnapshotData {
  id: string;
  name: string;
  text: string;
  template: string;
  conversation?: Entity;
  sourceRuntimeContexts?: Entity[];
  sourceHash?: string;
  createdAt: number;
  updatedAt: number;
  refreshedAt: number;
}
export const RuntimeContextSnapshot = defineComponent<RuntimeContextSnapshotData>('RuntimeContextSnapshot');

export interface ConversationRuntimeContextSnapshotLinkData {
  id: string;
  conversation: Entity;
  snapshot: Entity;
  role: ConfigScopeBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const ConversationRuntimeContextSnapshotLink = defineComponent<ConversationRuntimeContextSnapshotLinkData>('ConversationRuntimeContextSnapshotLink');

export interface RunRuntimeContextSnapshotLinkData {
  id: string;
  run: Entity;
  snapshot: Entity;
  role: 'context';
  createdAt: number;
  updatedAt: number;
}
export const RunRuntimeContextSnapshotLink = defineComponent<RunRuntimeContextSnapshotLinkData>('RunRuntimeContextSnapshotLink');
