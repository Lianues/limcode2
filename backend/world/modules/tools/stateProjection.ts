import type { ClientState, McpToolSourceRecord, ToolCallEventRecord, ToolCallRecord, ToolDefinitionRecord, ToolPolicyScopeLinkRecord } from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import {
  AgentRun,
  AgentRunTargetLink,
  RunModeLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from '../agentRun/components';
import { activeToolPolicyForRun, runForToolCall } from '../agentRun/queries';
import { Conversation, Message, PartOf } from '../chat/components';
import { ConversationModeSelection, Mode, ToolPolicy } from '../mode/components';
import { McpToolSourcesKey, ToolDefinitionsKey, ToolRuntimeDefinitionsKey } from './resources';
import { toolSchedulingDecision } from './scheduling';
import { ToolCall, ToolCallEvent, ToolPolicyScopeLink, ToolResultConsumed, ToolState, type ToolCallData, type ToolPolicyScopeLinkData } from './components';

export const toolsRuntimeStateProjectionReads: AccessDeclaration = {
  components: [
    Agent,
    Mode,
    AgentRun,
    Conversation,
    Message,
    PartOf,
    ToolPolicy,
    AgentRunTargetLink,
    ToolCallRunLink,
    RunModeLink,
    RunToolPolicyLink,
    ConversationModeSelection,
    ToolCall,
    ToolState,
    ToolCallEvent,
    ToolResultConsumed,
    ToolPolicyScopeLink
  ],
  resources: [ToolDefinitionsKey, ToolRuntimeDefinitionsKey, McpToolSourcesKey]
};

export const toolsClientStateProjectionReads: AccessDeclaration = {
  ...toolsRuntimeStateProjectionReads,
  resources: [ToolDefinitionsKey, ToolRuntimeDefinitionsKey, McpToolSourcesKey]
};

export const toolsStateProjectionReads = toolsClientStateProjectionReads;

export function projectToolsRuntimeState(world: WorldReader): Partial<ClientState> {
  const toolCalls = world
    .query(ToolCall, ToolState, PartOf)
    .map((entity) => buildToolCallRecord(world, entity))
    .filter((item): item is ToolCallRecord => item !== undefined);

  const toolCallEvents = world
    .query(ToolCallEvent, PartOf)
    .map((entity) => buildToolCallEventRecord(world, entity))
    .filter((item): item is ToolCallEventRecord => item !== undefined)
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));

  const toolPolicyScopeLinks = world
    .query(ToolPolicyScopeLink)
    .map((entity) => buildToolPolicyScopeLinkRecord(world, entity))
    .filter((item): item is ToolPolicyScopeLinkRecord => item !== undefined);

  return { toolCalls, toolCallEvents, toolPolicyScopeLinks };
}

export function projectToolsClientState(world: WorldReader): Partial<ClientState> {
  const toolDefinitions = world.tryGetResource(ToolDefinitionsKey) ?? [];
  const mcpToolSources = world.tryGetResource(McpToolSourcesKey) ?? [];
  return {
    toolDefinitions: toolDefinitions.map((tool): ToolDefinitionRecord => ({ ...tool })),
    mcpToolSources: mcpToolSources.map((source): McpToolSourceRecord => ({ ...source })),
    ...projectToolsRuntimeState(world)
  };
}

export const projectToolsState = projectToolsClientState;

function buildToolCallRecord(world: WorldReader, entity: number): ToolCallRecord | undefined {
  const call = world.get(entity, ToolCall);
  const state = world.get(entity, ToolState);
  const messageEntity = world.get(entity, PartOf)?.parent;
  if (!call || !state || messageEntity === undefined) return undefined;

  const message = world.get(messageEntity, Message);
  if (!message) return undefined;
  const scheduling = toolSchedulingDecision(world, entity);
  const summary = resolveToolCallSummary(world, call);
  const display = resolveToolCallDisplay(world, entity, call);

  return {
    id: call.id,
    messageId: message.id,
    name: call.name,
    functionCallId: call.functionCallId,
    args: call.argsJson,
    ...(summary ? { summary } : {}),
    status: state.status,
    ...(state.result !== undefined ? { result: stripToolResultAttachments(state.result) } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
    ...(state.progress !== undefined ? { progress: state.progress } : {}),
    schedulingMode: scheduling.mode,
    ...(scheduling.reason ? { schedulingReason: scheduling.reason } : {}),
    ...(display ? { display } : {}),
    ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
    createdAt: call.createdAt,
    updatedAt: state.updatedAt
  };
}

function stripToolResultAttachments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripToolResultAttachments);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === 'parts' && Array.isArray(child)) {
      result.parts = child.map((part) => {
        const inlineData = (part as { inlineData?: unknown })?.inlineData;
        if (!inlineData || typeof inlineData !== 'object') return part;
        const source = inlineData as Record<string, unknown>;
        return { inlineData: { ...source, data: undefined } };
      });
      continue;
    }
    result[key] = stripToolResultAttachments(child);
  }
  return result;
}

function resolveToolCallDisplay(world: WorldReader, entity: number, call: ToolCallData): { autoExpand?: boolean } | undefined {
  const run = runForToolCall(world, entity);
  if (run === undefined) return undefined;
  const display = activeToolPolicyForRun(world, run)?.toolConfigs?.[call.name]?.display;
  if (display?.autoExpand === true) return { autoExpand: true };
  if (display?.autoExpand === false) return { autoExpand: false };
  const definitions = world.tryGetResource(ToolRuntimeDefinitionsKey) ?? [];
  const definition = definitions.find((tool) => tool.declaration.name === call.name);
  return definition?.declaration.metadata?.defaultAutoExpand ? { autoExpand: true } : undefined;
}


function resolveToolCallSummary(world: WorldReader, call: ToolCallData): string | undefined {
  const definitions = world.tryGetResource(ToolRuntimeDefinitionsKey) ?? [];
  const definition = definitions.find((tool) => tool.declaration.name === call.name);
  if (!definition?.summary) return undefined;

  try {
    return normalizeToolCallSummary(definition.summary(parseToolCallArgs(call.argsJson), {
      toolName: call.name,
      argsJson: call.argsJson
    }));
  } catch {
    return undefined;
  }
}

function parseToolCallArgs(argsJson: string): unknown {
  try {
    return argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return argsJson;
  }
}

function normalizeToolCallSummary(summary: string | undefined): string | undefined {
  const text = summary?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function buildToolCallEventRecord(world: WorldReader, entity: number): ToolCallEventRecord | undefined {
  const event = world.get(entity, ToolCallEvent);
  if (!event) return undefined;
  return { ...event };
}

function buildToolPolicyScopeLinkRecord(world: WorldReader, entity: number): ToolPolicyScopeLinkRecord | undefined {
  const link = world.get(entity, ToolPolicyScopeLink);
  if (!link) return undefined;
  const policy = world.get(link.toolPolicy, ToolPolicy);
  if (!policy) return undefined;
  const scopeId = link.scopeId ?? resolveScopeId(world, link);
  if (link.scopeKind !== 'global' && !scopeId) return undefined;
  return {
    id: link.id,
    scopeKind: link.scopeKind,
    ...(scopeId ? { scopeId } : {}),
    toolPolicyId: policy.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function resolveScopeId(world: WorldReader, link: ToolPolicyScopeLinkData): string | undefined {
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
