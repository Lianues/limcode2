import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import type { SkillPolicyScopeKind, SkillPolicySourceConfigRecord, SkillSource } from '../../../../shared/protocol';
import { SkillPolicy, SkillPolicyScopeLink } from './components';

export const SkillPolicyBundle = defineBundle({
  name: 'SkillPolicyBundle',
  writes: [SkillPolicy, SkillPolicyScopeLink],
  mutationMode: 'create',
  spawns: true
});

export function spawnSkillPolicy(
  cmd: CommandSink,
  input: { id: string; name: string; sourceConfigs?: Partial<Record<SkillSource, SkillPolicySourceConfigRecord>> }
): Entity {
  const entity = cmd.spawn();
  cmd.add(entity, SkillPolicy, {
    id: input.id,
    name: input.name,
    ...(input.sourceConfigs ? { sourceConfigs: input.sourceConfigs } : {})
  });
  return entity;
}

export function linkSkillPolicyToScope(
  cmd: CommandSink,
  input: { scopeKind: SkillPolicyScopeKind; scopeId?: string; skillPolicy: Entity; agent?: Entity; mode?: Entity; conversation?: Entity; run?: Entity }
): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, SkillPolicyScopeLink, {
    id: `skill-policy-scope:${input.scopeKind}:${input.scopeId ?? 'global'}`,
    scopeKind: input.scopeKind,
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    skillPolicy: input.skillPolicy,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    ...(input.run !== undefined ? { run: input.run } : {}),
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}
