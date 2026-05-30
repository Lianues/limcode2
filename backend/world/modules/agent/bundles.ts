import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import { NeedsResponse, Message, PartOf, Session } from '../chat/components';
import { spawnUserMessage, spawnSession } from '../chat/bundles';
import {
  Agent,
  AgentConversationLink,
  AgentKind,
  AgentStatus,
  ModelProfile,
  ParentAgent,
  SystemPrompt,
  ToolPolicy
} from './components';
import type { AgentBlueprint } from './blueprints';

export const AgentFromBlueprintBundle = defineBundle({
  name: 'AgentFromBlueprintBundle',
  writes: [
    Agent,
    AgentKind,
    AgentStatus,
    ModelProfile,
    ToolPolicy,
    SystemPrompt,
    ParentAgent,
    Session,
    AgentConversationLink,
    Message,
    PartOf,
    NeedsResponse
  ],
  mutationMode: 'create',
  spawns: true
});

export interface SpawnAgentFromBlueprintInput {
  blueprint: AgentBlueprint;
  agentId: string;
  sessionId: string;
  agentName?: string;
  parentAgent?: Entity;
  initialTask?: string;
}

export interface SpawnAgentFromBlueprintResult {
  agent: Entity;
  session: Entity;
  link: Entity;
}

export function spawnAgentFromBlueprint(
  cmd: CommandSink,
  input: SpawnAgentFromBlueprintInput
): SpawnAgentFromBlueprintResult {
  const agent = cmd.spawn();
  cmd.add(agent, Agent, { id: input.agentId, name: input.agentName ?? input.blueprint.name });
  cmd.add(agent, AgentKind, { kind: input.blueprint.kind });
  cmd.add(agent, AgentStatus, { status: 'idle' });
  cmd.add(agent, ModelProfile, input.blueprint.model);
  cmd.add(agent, ToolPolicy, input.blueprint.toolPolicy);
  cmd.add(agent, SystemPrompt, { text: input.blueprint.systemPrompt });
  if (input.parentAgent !== undefined) {
    cmd.add(agent, ParentAgent, { parent: input.parentAgent });
  }

  const session = spawnSession(cmd, { id: input.sessionId });
  const link = cmd.spawn();
  const now = Date.now();
  cmd.add(link, AgentConversationLink, {
    id: `acl${link}`,
    agent,
    conversation: session,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });

  if (input.initialTask && input.initialTask.trim()) {
    spawnUserMessage(cmd, session, input.initialTask.trim());
    cmd.add(session, NeedsResponse, { since: Date.now() });
  }

  return { agent, session, link };
}
