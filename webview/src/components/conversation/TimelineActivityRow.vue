<script setup lang="ts">
import StreamingIndicatorTail from '@webview/components/content/StreamingIndicatorTail.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';

const props = defineProps<{
  activityKind: 'preparing';
}>();

const settings = useGlobalSettingsStore();
</script>

<template>
  <article class="timeline-activity-row assistant" :data-activity-kind="props.activityKind">
    <div class="activity-container">
      <div class="activity-content-column">
        <header class="activity-header">
          <span class="role-chip assistant">
            <span class="role-dot" aria-hidden="true"></span>
            <span class="activity-role-name">AI</span>
          </span>
        </header>
        <div class="activity-body">
          <StreamingIndicatorTail :text="settings.appearance.streamingTextPreparing" variant="preparing" />
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.timeline-activity-row {
  position: relative;
  width: 100%;
  --message-floor-padding-block: 10px;
  padding: var(--message-floor-padding-block) var(--conversation-content-padding-right, calc(var(--space-4) + 24px))
    var(--message-floor-padding-block) var(--conversation-content-padding-left, var(--space-4));
  box-sizing: border-box;
  background-color: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
  transition: background-color var(--lc-message-bg-transition-duration) ease;
}

.activity-container {
  max-width: 100%;
}

.activity-content-column {
  width: 100%;
  min-width: 0;
}

.activity-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 22px;
  margin-bottom: var(--space-1);
}

.role-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.role-chip.assistant {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.role-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: currentColor;
}

.activity-role-name {
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: currentColor;
}

.activity-body {
  min-height: 1.6em;
  font-size: var(--font-size-md);
  line-height: 1.6;
  color: var(--vscode-foreground);
}
</style>
