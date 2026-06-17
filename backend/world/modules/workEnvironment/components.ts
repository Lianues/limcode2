import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  WorkEnvironmentKind,
  WorkEnvironmentLinkRole,
  WorkEnvironmentOs,
  WorkEnvironmentPolicyScopeKind,
  WorkEnvironmentSource
} from '../../../../shared/protocol';

export interface WorkEnvironmentData {
  id: string;
  kind: WorkEnvironmentKind;
  name: string;
  uri?: string;
  rootPath?: string;
  displayPath?: string;
  source?: WorkEnvironmentSource;
  host?: string;
  port?: number;
  user?: string;
  identityFile?: string;
  password?: string;
  workdir?: string;
  os?: WorkEnvironmentOs;
  description?: string;
  index?: number;
  available: boolean;
  createdAt: number;
  updatedAt: number;
}
export const WorkEnvironment = defineComponent<WorkEnvironmentData>('WorkEnvironment');

export interface WorkEnvironmentPolicyData {
  id: string;
  name: string;
  allowedWorkEnvironmentIds: string[];
  defaultWorkEnvironmentId?: string;
  createdAt: number;
  updatedAt: number;
}
export const WorkEnvironmentPolicy = defineComponent<WorkEnvironmentPolicyData>('WorkEnvironmentPolicy');

export interface WorkEnvironmentPolicyScopeLinkData {
  id: string;
  scopeKind: WorkEnvironmentPolicyScopeKind;
  scopeId?: string;
  policy: Entity;
  conversation?: Entity;
  agent?: Entity;
  mode?: Entity;
  run?: Entity;
  agentSystemId?: string;
  role: WorkEnvironmentLinkRole;
  createdAt: number;
  updatedAt: number;
}
export const WorkEnvironmentPolicyScopeLink = defineComponent<WorkEnvironmentPolicyScopeLinkData>('WorkEnvironmentPolicyScopeLink');

export interface ConversationWorkEnvironmentLinkData {
  id: string;
  conversation: Entity;
  workEnvironment: Entity;
  role: WorkEnvironmentLinkRole;
  createdAt: number;
  updatedAt: number;
}
export const ConversationWorkEnvironmentLink = defineComponent<ConversationWorkEnvironmentLinkData>('ConversationWorkEnvironmentLink');

export interface RunWorkEnvironmentLinkData {
  id: string;
  run: Entity;
  workEnvironment: Entity;
  role: WorkEnvironmentLinkRole;
  createdAt: number;
  updatedAt: number;
}
export const RunWorkEnvironmentLink = defineComponent<RunWorkEnvironmentLinkData>('RunWorkEnvironmentLink');
