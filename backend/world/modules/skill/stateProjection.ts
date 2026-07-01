import type { ClientState, SkillDefinitionRecord, SkillPolicyRecord, SkillPolicyScopeLinkRecord } from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { AgentRun } from '../agentRun/components';
import { Conversation } from '../chat/components';
import { Mode } from '../mode/components';
import { SkillCatalogKey } from './resources';
import { SkillPolicy, SkillPolicyScopeLink, type SkillPolicyScopeLinkData } from './components';

/** 落盘投影只涉及 ECS 组件（策略 + 关系），不含磁盘扫描的技能目录。 */
export const skillRuntimeStateProjectionReads: AccessDeclaration = {
  components: [Agent, AgentRun, Conversation, Mode, SkillPolicy, SkillPolicyScopeLink]
};

/** ClientState 投影额外读取 SkillCatalog 资源，把技能目录也同步给前端。 */
export const skillClientStateProjectionReads: AccessDeclaration = {
  ...skillRuntimeStateProjectionReads,
  resources: [SkillCatalogKey]
};

export function projectSkillRuntimeState(world: WorldReader): Partial<ClientState> {
  const skillPolicies: SkillPolicyRecord[] = world.query(SkillPolicy).map((entity) => ({ ...world.get(entity, SkillPolicy)! }));
  const skillPolicyScopeLinks = world
    .query(SkillPolicyScopeLink)
    .map((entity) => buildSkillPolicyScopeLinkRecord(world, entity))
    .filter((item): item is SkillPolicyScopeLinkRecord => item !== undefined);
  return { skillPolicies, skillPolicyScopeLinks };
}

export function projectSkillClientState(world: WorldReader): Partial<ClientState> {
  const skillDefinitions = (world.tryGetResource(SkillCatalogKey) ?? []).map((skill): SkillDefinitionRecord => ({ ...skill }));
  return {
    skillDefinitions,
    ...projectSkillRuntimeState(world)
  };
}

function buildSkillPolicyScopeLinkRecord(world: WorldReader, entity: number): SkillPolicyScopeLinkRecord | undefined {
  const link = world.get(entity, SkillPolicyScopeLink);
  if (!link) return undefined;
  const policy = world.get(link.skillPolicy, SkillPolicy);
  if (!policy) return undefined;
  const scopeId = link.scopeId ?? resolveScopeId(world, link);
  if (link.scopeKind !== 'global' && !scopeId) return undefined;
  return {
    id: link.id,
    scopeKind: link.scopeKind,
    ...(scopeId ? { scopeId } : {}),
    skillPolicyId: policy.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function resolveScopeId(world: WorldReader, link: SkillPolicyScopeLinkData): string | undefined {
  switch (link.scopeKind) {
    case 'global':
      return undefined;
    case 'conversation':
      return link.conversation !== undefined ? world.get(link.conversation, Conversation)?.id : undefined;
    case 'agent':
      return link.agent !== undefined ? world.get(link.agent, Agent)?.id : undefined;
    case 'mode':
      return link.mode !== undefined ? world.get(link.mode, Mode)?.id : undefined;
    case 'run':
      return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
    case 'agentSystem':
      return link.agentSystemId;
  }
}
