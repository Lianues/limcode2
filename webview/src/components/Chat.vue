<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MsgRole } from '@shared/protocol';
import { bridge, BridgeMessageType } from '../bridge/vscodeBridge';
import { applyClientPatch, applyClientSnapshot, clientState } from '../stores/clientStateStore';

const input = ref('');
const scroller = ref<HTMLElement | null>(null);
const disposers: Array<() => void> = [];

const sessionMessages = computed(() =>
  clientState.messages.filter((message) => message.sessionId === clientState.currentSessionId).sort((a, b) => a.seq - b.seq)
);

const activeAgentLink = computed(() =>
  clientState.agentConversationLinks.find((link) => link.sessionId === clientState.currentSessionId && link.role === 'active')
    ?? clientState.agentConversationLinks.find((link) => link.sessionId === clientState.currentSessionId)
);

const currentAgent = computed(() =>
  clientState.agents.find((agent) => agent.id === activeAgentLink.value?.agentId)
);

function toolCallsForMessage(messageId: string) {
  return clientState.toolCalls.filter((toolCall) => toolCall.messageId === messageId);
}

function send(): void {
  const text = input.value.trim();
  if (!text || !clientState.currentSessionId) return;
  bridge.request(BridgeMessageType.ChatSend, { sessionId: clientState.currentSessionId, text });
  input.value = '';
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

function resync(): void {
  if (clientState.currentSessionId) {
    bridge.request(BridgeMessageType.ClientResync, { sessionId: clientState.currentSessionId });
  } else {
    bridge.request(BridgeMessageType.ClientResync, {});
  }
}

function roleLabel(role: MsgRole): string {
  if (role === 'user') return '你';
  return role === 'assistant' ? '助手' : '工具';
}

function scrollToBottom(): void {
  void nextTick(() => {
    const element = scroller.value;
    if (element) element.scrollTop = element.scrollHeight;
  });
}

watch(() => sessionMessages.value.reduce((acc, message) => acc + message.text.length, sessionMessages.value.length), scrollToBottom);

onMounted(() => {
  disposers.push(
    bridge.on(BridgeMessageType.ClientSnapshot, (message) => {
      if (!message.payload) return;
      applyClientSnapshot(message.payload.version, message.payload.state);
    })
  );
  disposers.push(
    bridge.on(BridgeMessageType.ClientPatch, (message) => {
      if (!message.payload) return;
      if (!applyClientPatch(message.payload.version, message.payload.patches)) resync();
    })
  );
  resync();
});

onBeforeUnmount(() => disposers.forEach((dispose) => dispose()));
</script>

<template>
  <div class="chat">
    <header class="chat-header">
      <span class="title">LimCode AI</span>
      <span class="hint">
        <template v-if="clientState.currentSessionId">
          当前会话：<code>{{ clientState.currentSessionId }}</code>
          <template v-if="currentAgent?.model?.model"> · 模型：<code>{{ currentAgent.model.model }}</code></template>
        </template>
        <template v-else>正在初始化默认会话...</template>
      </span>
    </header>

    <div ref="scroller" class="messages">
      <div v-for="m in sessionMessages" :key="m.id" class="msg" :class="m.role">
        <div class="meta">{{ roleLabel(m.role) }}</div>
        <div class="bubble">
          <pre class="text">{{ m.text }}<span v-if="m.status === 'streaming'" class="cursor">▋</span></pre>
          <div v-if="toolCallsForMessage(m.id).length" class="tools">
            <div v-for="t in toolCallsForMessage(m.id)" :key="t.id" class="tool" :class="t.status">
              <span class="tool-name">⚙ {{ t.name }}</span>
              <span class="tool-status">{{ t.status }}</span>
              <code class="tool-args">{{ t.args }}</code>
            </div>
          </div>
        </div>
      </div>
      <p v-if="!sessionMessages.length" class="empty">
        {{ clientState.currentSessionId ? '还没有消息，发一条试试。' : '默认会话初始化中，请稍候。' }}
      </p>
    </div>

    <footer class="composer">
      <textarea v-model="input" rows="2" :placeholder="clientState.currentSessionId ? '输入消息，Enter 发送，Shift+Enter 换行' : '默认会话初始化中...'" @keydown="onKeydown"></textarea>
      <button type="button" :disabled="!input.trim() || !clientState.currentSessionId" @click="send">发送</button>
    </footer>
  </div>
</template>

<style scoped>
.chat { display: flex; flex-direction: column; height: 100vh; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
.chat-header { display: flex; align-items: baseline; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
.chat-header .title { font-weight: 600; }
.chat-header .hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 4px; }
.messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.msg { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
.msg .meta { font-size: 11px; color: var(--vscode-descriptionForeground); }
.msg.user { align-items: flex-end; }
.bubble { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 8px 12px; background: var(--vscode-editor-background); max-width: 90%; }
.msg.user .bubble { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.msg.tool .bubble { background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-foreground) 20%); }
.text { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; }
.cursor { animation: blink 1s steps(2, start) infinite; }
@keyframes blink { to { opacity: 0; } }
.tools { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.tool { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); }
.tool .tool-status { text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
.tool.running { border-color: var(--vscode-progressBar-background); }
.tool.failed { border-color: var(--vscode-errorForeground); }
.tool-args { color: var(--vscode-descriptionForeground); }
.empty { color: var(--vscode-descriptionForeground); text-align: center; margin-top: 40px; }
.composer { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--vscode-panel-border); }
.composer textarea { flex: 1; resize: none; border-radius: 6px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; padding: 8px; }
.composer button { align-self: flex-end; border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; font: inherit; }
.composer button:disabled { opacity: 0.5; cursor: default; }
.composer button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
</style>
