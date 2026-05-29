import type { AgentRecord, ClientPatchOp, ClientState } from '../../../../shared/protocol';
import type { WorldReader } from '../../../ecs/types';
import { diffUpsertRemove } from '../../clientSync/diff';
import { defineClientStateContributor, type ClientStateSlice } from '../../clientSync/contributors';
import { Agent, AgentKind, AgentStatus, ModelProfile, ParentAgent, SystemPrompt, ToolPolicy } from './components';

export function projectAgentClientState(world: WorldReader): ClientStateSlice {
  const agents: AgentRecord[] = world.query(Agent).map((entity) => {
    const agent = world.get(entity, Agent)!;
    const model = world.get(entity, ModelProfile);
    const toolPolicy = world.get(entity, ToolPolicy);
    return {
      id: agent.id,
      name: agent.name,
      kind: world.get(entity, AgentKind)?.kind ?? 'unknown',
      status: world.get(entity, AgentStatus)?.status ?? 'idle',
      parentAgentId: (() => {
        const parentEntity = world.get(entity, ParentAgent)?.parent;
        return parentEntity === undefined ? undefined : world.get(parentEntity, Agent)?.id;
      })(),
      model: model
        ? {
            provider: model.provider,
            model: model.model,
            temperature: model.temperature
          }
        : undefined,
      toolPolicy: toolPolicy
        ? {
            allowedTools: toolPolicy.allowedTools,
            approvalMode: toolPolicy.approvalMode
          }
        : undefined,
      systemPrompt: world.get(entity, SystemPrompt)?.text
    };
  });
  return { agents };
}

export function diffAgentClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  return diffUpsertRemove(
    prev.agents,
    next.agents,
    (agent): ClientPatchOp => ({ kind: 'agent.upsert', agent }),
    (id): ClientPatchOp => ({ kind: 'agent.remove', id })
  );
}

export const agentClientSyncContributor = defineClientStateContributor({
  key: 'agents',
  reads: { components: [Agent, AgentKind, AgentStatus, ParentAgent, ModelProfile, ToolPolicy, SystemPrompt] },
  project: projectAgentClientState,
  diff: diffAgentClientState,
  worker: {
    modulePath: '../world/modules/agent/clientSync',
    projectExport: 'projectAgentClientState',
    diffExport: 'diffAgentClientState'
  }
});
