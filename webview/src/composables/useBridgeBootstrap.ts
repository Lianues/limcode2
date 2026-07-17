import { onBeforeUnmount, watch } from 'vue';
import { GLOBAL_SETTINGS_SECTIONS, conversationClientStateStreamId, type BridgeScope, type GlobalSettingsSection } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useSessionStore } from '@webview/stores/useSessionStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import { useRunHistoryStore } from '@webview/stores/useRunHistoryStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { useConversationUiStore } from '@webview/stores/useConversationUiStore';
import { useSystemPromptStore } from '@webview/stores/useSystemPromptStore';
import { useRuntimeContextStore } from '@webview/stores/useRuntimeContextStore';

/**
 * 在 App 根组件挂载时调用一次：集中注册所有入站桥接监听并接入对应 store，
 * 卸载时清理。组件层不再直接监听 bridge。
 */

function globalSettingsSectionFromScope(scope: BridgeScope | undefined): GlobalSettingsSection | undefined {
  if (scope?.kind !== 'settings' || scope.level !== 'global') return undefined;
  const section = scope.id;
  return GLOBAL_SETTINGS_SECTIONS.includes(section as GlobalSettingsSection)
    ? section as GlobalSettingsSection
    : undefined;
}

function logCompressionClientDebug(stage: string, payload: Record<string, unknown>): void {
  console.info('[LimCode][Compression][Webview]', stage, payload);
}

function compressionSnapshotDebug(state: { compressionBlocks?: Array<{ id: string; status: string; error?: string; sourceHash?: string; anchorSeq?: number; endSeq?: number; methodKind?: string }>; compressionBlockLlmInvocationLinks?: Array<{ blockId: string; invocationId: string }>; llmInvocations?: Array<{ id: string; status: string; error?: string }> }): Record<string, unknown> | undefined {
  const blocks = state.compressionBlocks ?? [];
  const links = state.compressionBlockLlmInvocationLinks ?? [];
  if (blocks.length === 0 && links.length === 0) return undefined;
  const invocationIds = new Set(links.map((link) => link.invocationId));
  const invocations = (state.llmInvocations ?? []).filter((invocation) => invocationIds.has(invocation.id));
  return {
    compressionBlockCount: blocks.length,
    compressionBlocks: blocks.slice(-8).map((block) => ({
      id: block.id,
      status: block.status,
      methodKind: block.methodKind,
      anchorSeq: block.anchorSeq,
      endSeq: block.endSeq,
      error: block.error
    })),
    compressionInvocationLinkCount: links.length,
    compressionInvocations: invocations.slice(-8)
  };
}

function compressionPatchDebug(patches: readonly { kind: string; [key: string]: unknown }[]): Record<string, unknown> | undefined {
  const compressionPatches = patches.filter((patch) =>
    patch.kind.startsWith('compressionBlock')
    || patch.kind.startsWith('compressionContextVariant')
    || patch.kind.startsWith('runCompressionBlockLink')
  );
  if (compressionPatches.length === 0) return undefined;
  return {
    compressionPatchCount: compressionPatches.length,
    compressionPatches: compressionPatches.slice(0, 12).map((patch) => summarizeCompressionPatch(patch)),
    omittedPatchCount: Math.max(0, compressionPatches.length - 12)
  };
}

function summarizeCompressionPatch(patch: { kind: string; [key: string]: unknown }): Record<string, unknown> {
  const block = patch.block as { id?: string; status?: string; methodKind?: string; anchorSeq?: number; endSeq?: number; error?: string } | undefined;
  const link = patch.link as { id?: string; blockId?: string; invocationId?: string; sourceId?: string; sourceKind?: string; role?: string } | undefined;
  const variant = patch.variant as { id?: string; blockId?: string; kind?: string } | undefined;
  return {
    kind: patch.kind,
    id: typeof patch.id === 'string' ? patch.id : block?.id ?? link?.id ?? variant?.id,
    block: block ? { id: block.id, status: block.status, methodKind: block.methodKind, anchorSeq: block.anchorSeq, endSeq: block.endSeq, error: block.error } : undefined,
    link: link ? { id: link.id, blockId: link.blockId, invocationId: link.invocationId, sourceKind: link.sourceKind, sourceId: link.sourceId, role: link.role } : undefined,
    variant: variant ? { id: variant.id, blockId: variant.blockId, kind: variant.kind } : undefined
  };
}

export function useBridgeBootstrap(): void {
  const session = useSessionStore();
  const clientState = useClientStateStore();
  const globalSettings = useGlobalSettingsStore();
  const conversationSettings = useConversationSettingsStore();
  const runHistory = useRunHistoryStore();
  const conversationTimeline = useConversationTimelineStore();
  const conversationUi = useConversationUiStore();
  const systemPromptStore = useSystemPromptStore();
  const runtimeContextStore = useRuntimeContextStore();

  const disposers: Array<() => void> = [];
  const requestedConversationStreams = new Set<string>();

  function ensureConversationStream(conversationId: string): void {
    if (!conversationId) return;
    const streamId = conversationClientStateStreamId(conversationId);
    if (requestedConversationStreams.has(streamId)) return;
    requestedConversationStreams.add(streamId);
    bridge.request(BridgeMessageType.ClientResync, { conversationId, streamId });
  }

  function resync(): void {
    const conversationId = clientState.currentConversationId;
    if (conversationId) {
      bridge.request(BridgeMessageType.ClientResync, {
        conversationId,
        streamId: conversationClientStateStreamId(conversationId)
      });
    } else {
      bridge.request(BridgeMessageType.ClientResync, {});
    }
  }

  disposers.push(
    bridge.on(BridgeMessageType.Hello, (message) => {
      session.applyHello(message.payload?.meta);
      if (session.viewKind === 'globalSettings') {
        globalSettings.requestAll();
        return;
      }
      if (session.viewKind === 'workflowSettings') {
        globalSettings.requestChannelSettings();
        return;
      }
      if (session.viewKind === 'agentSettings') {
        globalSettings.requestChannelSettings();
        return;
      }
      globalSettings.requestChannelSettings();
      globalSettings.ensureAppearance();

      if (message.payload?.meta?.conversationId) {
        clientState.setCurrentConversation(message.payload.meta.conversationId);
      }
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ClientSnapshot, (message) => {
      if (!message.payload) return;
      const debug = compressionSnapshotDebug(message.payload.state);
      if (debug) logCompressionClientDebug('clientSnapshot.received', { streamId: message.payload.streamId, streamSeq: message.payload.streamSeq, ...debug });
      clientState.applyClientSnapshot(message.payload.streamId, message.payload.streamSeq, message.payload.state);
      conversationTimeline.applyClientStateSnapshot(message.payload.streamId, message.payload.streamSeq, message.payload.state);
      systemPromptStore.reconcilePendingSave();
      runtimeContextStore.reconcilePendingSave();
      if (debug) logCompressionClientDebug('clientSnapshot.applied', { streamId: message.payload.streamId, streamSeq: message.payload.streamSeq });
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ClientPatch, (message) => {
      if (!message.payload) return;
      const debug = compressionPatchDebug(message.payload.patches);
      if (debug) logCompressionClientDebug('clientPatch.received', { streamId: message.payload.streamId, streamSeq: message.payload.streamSeq, ...debug });
      const applied = clientState.applyClientPatch(
        message.payload.streamId,
        message.payload.streamSeq,
        message.payload.patches
      );
      if (debug) logCompressionClientDebug('clientPatch.applyResult', { streamId: message.payload.streamId, streamSeq: message.payload.streamSeq, applied });
      if (applied) {
        conversationTimeline.applyClientStatePatch(message.payload.streamId, message.payload.streamSeq, message.payload.patches);
        systemPromptStore.reconcilePendingSave();
        runtimeContextStore.reconcilePendingSave();
      }
      if (!applied) {
        if (debug) logCompressionClientDebug('clientPatch.resync', { streamId: message.payload.streamId, streamSeq: message.payload.streamSeq });
        resync();
      }
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ConversationTimelinePageSnapshot, (message) => {
      if (message.payload) conversationTimeline.applyPageSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ConversationTimelinePatch, (message) => {
      if (message.payload) conversationTimeline.applyTimelinePatch(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.GlobalSettingsSnapshot, (message) => {
      if (message.payload) globalSettings.applySnapshot(message.payload, message.correlationId);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ConversationSettingsSnapshot, (message) => {
      if (message.payload) conversationSettings.applySnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.RunHistoryPageSnapshot, (message) => {
      if (message.payload) runHistory.applyPageSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.RunHistoryDetailSnapshot, (message) => {
      if (message.payload) runHistory.applyDetailSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.LlmDryRunSnapshot, (message) => {
      if (message.payload) runHistory.applyDryRunSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.LlmTransientNotice, (message) => {
      if (message.payload) conversationUi.applyLlmTransientNotice(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.LlmProviderModelsSnapshot, (message) => {
      if (message.payload) globalSettings.applyLlmProviderModelsSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.Error, (message) => {
      if (
        message.payload?.requestType === BridgeMessageType.GlobalSettingsGet
        || message.payload?.requestType === BridgeMessageType.GlobalSettingsUpdate
        || message.payload?.requestType === BridgeMessageType.LlmProviderModelsGet
      ) {
        globalSettings.setError(message.payload.message, {
          requestType: message.payload.requestType,
          section: globalSettingsSectionFromScope(message.scope)
        });
      } else if (message.payload?.requestType === BridgeMessageType.ConversationTimelinePageGet) {
        conversationTimeline.setError(clientState.currentConversationId, message.payload.message);
      } else if (message.payload?.requestType === BridgeMessageType.RunHistoryPageGet || message.payload?.requestType === BridgeMessageType.RunHistoryDetailGet || message.payload?.requestType === BridgeMessageType.LlmDryRunGet) {
        runHistory.setError(message.payload.message);
      }
    })
  );

  // 当前对话 id 变化（Hello 指定 / 全局快照默认回落）时：订阅该对话数据流 + 读取对话设置。
  disposers.push(
    watch(
      () => clientState.currentConversationId,
      (conversationId) => {
        if ((session.viewKind !== 'chat' && session.viewKind !== 'planDetail') || !conversationId) return;
        conversationTimeline.setCurrentConversation(conversationId);
        ensureConversationStream(conversationId);
        if (session.viewKind === 'chat' && conversationTimeline.ensureTimeline(conversationId).pageInfo === undefined) {
          conversationTimeline.requestInitial(conversationId);
        }
        conversationSettings.request(conversationId);
      },
      { immediate: true }
    )
  );

  bridge.ready();

  onBeforeUnmount(() => {
    for (const dispose of disposers) dispose();
  });
}
