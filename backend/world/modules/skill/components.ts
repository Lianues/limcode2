import { defineComponent, type Entity } from '../../../ecs/types';
import type { PolicyBindingRole, SkillPolicyScopeKind, SkillPolicySourceConfigRecord, SkillSource } from '../../../../shared/protocol';

export interface SkillPolicyData {
  id: string;
  name: string;
  sourceConfigs?: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>>;
}
export const SkillPolicy = defineComponent<SkillPolicyData>('SkillPolicy');

export interface SkillPolicyScopeLinkData {
  id: string;
  scopeKind: SkillPolicyScopeKind;
  scopeId?: string;
  skillPolicy: Entity;
  conversation?: Entity;
  agent?: Entity;
  workflow?: Entity;
  run?: Entity;
  agentSystemId?: string;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const SkillPolicyScopeLink = defineComponent<SkillPolicyScopeLinkData>('SkillPolicyScopeLink');
