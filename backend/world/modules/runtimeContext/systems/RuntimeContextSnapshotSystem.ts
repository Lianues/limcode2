import { defineSystem, type CommandSink, type ComponentType, type Entity, type WorldReader } from '../../../../ecs/types';
import { createMessageId } from '../../../../../shared/protocol';
import { readEvents } from '../../../events';
import { Agent } from '../../agent/components';
import { AgentRun, AgentRunTargetLink } from '../../agentRun/components';
import { Conversation, InFlight, LlmRequest } from '../../chat/components';
import { ConversationModeSelection, Mode } from '../../mode/components';
import { ConversationProjectLink, ProjectContext } from '../../project/components';
import {
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink
} from '../../workEnvironment/components';
import {
  ConversationRuntimeContextSnapshotLink,
  RuntimeContext,
  RuntimeContextScopeLink,
  RuntimeContextSnapshot,
  RunRuntimeContextSnapshotLink
} from '../components';
import { linkRuntimeContextSnapshotToConversation, linkRuntimeContextSnapshotToRun, spawnRuntimeContextSnapshot } from '../bundles';
import { RuntimeContextEventType } from '../events';
import { renderRuntimeContextTemplate, runtimeContextSourceHash } from '../placeholders';
import { activeRuntimeContextSnapshotForConversation, runtimeContextsForConversation, runtimeContextsForRun, runRuntimeContextSnapshots } from '../queries';

export const RuntimeContextSnapshotSystem = defineSystem({
  name: 'RuntimeContextSnapshotSystem',
  shouldRun(ctx) {
    return readEvents(ctx, RuntimeContextEventType.Refresh).length > 0
      || readEvents(ctx, RuntimeContextEventType.SnapshotClear).length > 0
      || ctx.world.query(LlmRequest).some((entity) => !ctx.world.has(entity, InFlight));
  },
  access: {
    reads: {
      components: [
        LlmRequest,
        InFlight,
        Agent,
        AgentRun,
        AgentRunTargetLink,
        Conversation,
        ConversationModeSelection,
        Mode,
        ConversationProjectLink,
        ProjectContext,
        WorkEnvironment,
        WorkEnvironmentPolicy,
        WorkEnvironmentPolicyScopeLink,
        ConversationWorkEnvironmentLink,
        RunWorkEnvironmentLink,
        RuntimeContext,
        RuntimeContextScopeLink,
        RuntimeContextSnapshot,
        ConversationRuntimeContextSnapshotLink,
        RunRuntimeContextSnapshotLink
      ]
    },
    writes: { components: [RuntimeContextSnapshot, ConversationRuntimeContextSnapshotLink, RunRuntimeContextSnapshotLink], mutationMode: 'update' },
    events: { read: [RuntimeContextEventType.Refresh, RuntimeContextEventType.SnapshotClear] }
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const refreshedConversations = new Set<Entity>();
    const refreshedRuns = new Set<Entity>();
    for (const payload of readEvents(ctx, RuntimeContextEventType.SnapshotClear)) {
      if (payload.runId) {
        const run = findByRecordId(world, AgentRun, payload.runId);
        if (run !== undefined) clearRunSnapshotLinks(world, cmd, run);
      }
      if (payload.conversationId) {
        const conversation = findByRecordId(world, Conversation, payload.conversationId);
        if (conversation !== undefined) clearConversationSnapshotLinks(world, cmd, conversation);
      }
    }
    for (const payload of readEvents(ctx, RuntimeContextEventType.Refresh)) {
      if (payload.runId) {
        const run = findByRecordId(world, AgentRun, payload.runId);
        if (run !== undefined) {
          refreshedRuns.add(run);
          clearRunSnapshotLinks(world, cmd, run);
        }
      }
      const conversationId = payload.conversationId ?? (payload.scopeKind === 'conversation' ? payload.scopeId : undefined);
      if (conversationId) {
        const conversation = findByRecordId(world, Conversation, conversationId);
        if (conversation !== undefined) {
          refreshedConversations.add(conversation);
          clearConversationSnapshotLinks(world, cmd, conversation);
        }
      }
    }

    for (const conversation of refreshedConversations) {
      ensureConversationSnapshot(world, cmd, undefined, conversation, true);
    }

    const requests = world.query(LlmRequest).filter((request) => !world.has(request, InFlight));
    for (const request of requests) {
      const data = world.get(request, LlmRequest);
      if (!data) continue;
      if (!refreshedRuns.has(data.run) && runRuntimeContextSnapshots(world, data.run).length > 0) continue;
      const snapshot = ensureConversationSnapshot(world, cmd, data.run, data.conversation, refreshedConversations.has(data.conversation));
      if (snapshot === undefined) continue;
      linkRuntimeContextSnapshotToRun(cmd, { run: data.run, snapshot, id: `run-runtime-context:${data.run}:${snapshot}` });
    }
  }
});

function ensureConversationSnapshot(world: WorldReader, cmd: CommandSink, run: Entity | undefined, conversation: Entity, forceRefresh: boolean): Entity | undefined {
  const existing = activeRuntimeContextSnapshotForConversation(world, conversation);
  if (existing && !forceRefresh) return existing.entity;
  const built = buildSnapshot(world, run, conversation);
  if (!built) return undefined;
  const snapshot = spawnRuntimeContextSnapshot(cmd, built);
  clearConversationSnapshotLinks(world, cmd, conversation);
  linkRuntimeContextSnapshotToConversation(cmd, { conversation, snapshot, id: `conversation-runtime-context:${conversation}` });
  return snapshot;
}

function buildSnapshot(world: WorldReader, run: Entity | undefined, conversation: Entity): Parameters<typeof spawnRuntimeContextSnapshot>[1] | undefined {
  const contexts = run !== undefined ? runtimeContextsForRun(world, run, conversation) : runtimeContextsForConversation(world, conversation);
  if (contexts.length === 0) return undefined;
  const nowDate = new Date();
  const renderedParts = contexts
    .map((context) => {
      const text = renderRuntimeContextTemplate(context.template, { world, ...(run !== undefined ? { run } : {}), conversation, now: nowDate }).trim();
      if (!text) return '';
      const name = context.name.trim();
      return name ? `[${name}]\n${text}` : text;
    })
    .filter(Boolean);
  if (renderedParts.length === 0) return undefined;
  const template = contexts.map((context) => `[${context.name}]\n${context.template}`).join('\n\n');
  const text = renderedParts.join('\n\n');
  const now = Date.now();
  return {
    id: `runtime-context-snapshot:${createMessageId()}`,
    name: '运行时上下文快照',
    text,
    template,
    conversation,
    sourceRuntimeContexts: [],
    sourceHash: runtimeContextSourceHash(`${template}\n---\n${text}`),
    now
  };
}

function clearConversationSnapshotLinks(world: WorldReader, cmd: { despawn(entity: Entity): void }, conversation: Entity): void {
  for (const entity of world.query(ConversationRuntimeContextSnapshotLink)) {
    const link = world.get(entity, ConversationRuntimeContextSnapshotLink);
    if (link?.conversation === conversation && link.role === 'active') cmd.despawn(entity);
  }
}

function clearRunSnapshotLinks(world: WorldReader, cmd: { despawn(entity: Entity): void }, run: Entity): void {
  for (const entity of world.query(RunRuntimeContextSnapshotLink)) {
    const link = world.get(entity, RunRuntimeContextSnapshotLink);
    if (link?.run === run && link.role === 'context') cmd.despawn(entity);
  }
}

function findByRecordId<T extends { id: string }>(world: WorldReader, component: ComponentType<T>, id: string): Entity | undefined {
  return world.query(component).find((entity) => world.get(entity, component)?.id === id);
}
