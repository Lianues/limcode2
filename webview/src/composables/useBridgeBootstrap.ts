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

export function useBridgeBootstrap(): void {
  const session = useSessionStore();
  const clientState = useClientStateStore();
  const globalSettings = useGlobalSettingsStore();
  const conversationSettings = useConversationSettingsStore();
  const runHistory = useRunHistoryStore();
  const conversationTimeline = useConversationTimelineStore();
  const conversationUi = useConversationUiStore();

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
      if (session.viewKind === 'modeSettings') {
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
      clientState.applyClientSnapshot(message.payload.streamId, message.payload.streamSeq, message.payload.state);
      conversationTimeline.applyClientStateSnapshot(message.payload.streamId, message.payload.streamSeq, message.payload.state);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ClientPatch, (message) => {
      if (!message.payload) return;
      const applied = clientState.applyClientPatch(
        message.payload.streamId,
        message.payload.streamSeq,
        message.payload.patches
      );
      if (applied) {
        conversationTimeline.applyClientStatePatch(message.payload.streamId, message.payload.streamSeq, message.payload.patches);
      }
      if (!applied) resync();
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
        if (session.viewKind !== 'chat' || !conversationId) return;
        conversationTimeline.setCurrentConversation(conversationId);
        ensureConversationStream(conversationId);
        if (conversationTimeline.ensureTimeline(conversationId).loadedChunkIds.length === 0) {
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
