<script setup lang="ts">
import { computed } from 'vue';
import type { MessageRecord, MessageStopReason } from '@shared/protocol';
import RichContentView from '@webview/components/content/RichContentView.vue';

const props = defineProps<{
  message: MessageRecord;
}>();

const roleLabel = computed(() => (props.message.role === 'user' ? '你' : '助手'));
const streaming = computed(() => props.message.status === 'streaming');

const stopReasonLabel = computed<string | undefined>(() => {
  switch (props.message.stopReason) {
    case 'paused':
      return '已暂停';
    case 'cancelled':
      return '已终止';
    case 'replaced':
      return '已替换';
    case 'stale':
      return '已失效';
    default:
      return undefined;
  }
});

const stopReasonClass = computed<string | undefined>(() => {
  return props.message.stopReason ? `stop-${props.message.stopReason}` : undefined;
});

const stopReasonTitle = computed(() => titleForStopReason(props.message.stopReason));

function titleForStopReason(reason: MessageStopReason | undefined): string | undefined {
  switch (reason) {
    case 'paused':
      return '当前回复已暂停，可稍后恢复继续执行。';
    case 'cancelled':
      return '当前回复已被手动终止。';
    case 'replaced':
      return '当前回复已被新的任务替换。';
    case 'stale':
      return '当前回复已因上下文变化而失效。';
    default:
      return undefined;
  }
}
</script>

<template>
  <article class="message-floor" :class="[message.role, { streaming }]">
    <div class="floor-container">
      <div class="floor-sender-column">
        <div class="sender-avatar" :class="message.role">
          <svg
            v-if="message.role === 'user'"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
          <svg
            v-else
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="11" width="18" height="10" rx="2"></rect>
            <circle cx="12" cy="5" r="2"></circle>
            <path d="M12 7v4"></path>
            <line x1="8" y1="16" x2="8" y2="16.01"></line>
            <line x1="16" y1="16" x2="16" y2="16.01"></line>
          </svg>
        </div>
      </div>

      <div class="floor-content-column">
        <header class="floor-header">
          <span class="floor-role-name">{{ roleLabel }}</span>
          <span v-if="streaming" class="floor-status-badge is-streaming">正在输入</span>
          <span
            v-else-if="stopReasonLabel"
            class="floor-status-badge is-stop"
            :class="stopReasonClass"
            :title="stopReasonTitle"
          >
            {{ stopReasonLabel }}
          </span>
        </header>
        <div class="floor-body">
          <RichContentView :parts="message.content.parts" :streaming="streaming" />
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.message-floor {
  width: 100%;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.15));
  padding: var(--space-4) var(--space-4);
  box-sizing: border-box;
  background-color: var(--vscode-editor-background);
  transition: background-color 0.2s ease;
  animation: slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes slide-up {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message-floor.user {
  background-color: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
}

.message-floor.assistant {
  background-color: var(--vscode-editor-background);
}

.floor-container {
  display: flex;
  gap: var(--space-4);
  max-width: 100%;
}

.floor-sender-column {
  flex: 0 0 auto;
}

.sender-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  transition: all 0.2s ease;
}

.sender-avatar.user {
  background-color: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.1));
  color: var(--vscode-foreground);
}

.sender-avatar.assistant {
  background-color: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-border, transparent);
}

.floor-content-column {
  flex: 1;
  min-width: 0;
}

.floor-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  flex-wrap: wrap;
}

.floor-role-name {
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--vscode-foreground);
}

.floor-status-badge {
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

.floor-status-badge.is-streaming {
  background-color: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.floor-status-badge.is-streaming::after {
  content: '';
  width: 6px;
  height: 6px;
  background-color: var(--vscode-testing-iconPassedColor, #4caf50);
  border-radius: 50%;
  display: inline-block;
  animation: pulse-glow 1.5s infinite ease-in-out;
}

.floor-status-badge.is-stop {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  background-color: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.floor-status-badge.stop-paused {
  color: var(--vscode-testing-iconSkipped, var(--vscode-descriptionForeground));
}

.floor-status-badge.stop-cancelled {
  color: var(--vscode-errorForeground);
  border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
  background-color: var(--vscode-inputValidation-errorBackground, color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%));
}

.floor-status-badge.stop-replaced {
  color: var(--vscode-foreground);
  border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
}

.floor-status-badge.stop-stale {
  color: var(--vscode-descriptionForeground);
  border-style: dashed;
}

@keyframes pulse-glow {
  0% {
    transform: scale(0.85);
    opacity: 0.5;
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-testing-iconPassedColor, #4caf50) 40%, transparent);
  }
  50% {
    transform: scale(1.15);
    opacity: 1;
    box-shadow: 0 0 4px 1px var(--vscode-testing-iconPassedColor, #4caf50);
  }
  100% {
    transform: scale(0.85);
    opacity: 0.5;
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-testing-iconPassedColor, #4caf50) 40%, transparent);
  }
}

.floor-body {
  font-size: var(--font-size-md);
  line-height: 1.6;
  color: var(--vscode-foreground);
}

:deep(pre) {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.15));
  border-radius: var(--radius-md) !important;
  background-color: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-foreground) 5%) !important;
}
</style>
