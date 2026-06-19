<script setup lang="ts">
import { computed } from 'vue';
import { IconChevronRight } from '@tabler/icons-vue';

const props = withDefaults(
  defineProps<{
    expanded?: boolean;
    collapsible?: boolean;
    ariaLabel?: string;
    kind?: 'input' | 'output';
    iconActive?: boolean;
  }>(),
  {
    expanded: false,
    collapsible: true,
    kind: 'input',
    iconActive: false
  }
);

const emit = defineEmits<{
  (event: 'update:expanded', value: boolean): void;
}>();

const isExpanded = computed(() => props.expanded === true);

function toggleExpanded(): void {
  if (!props.collapsible) return;
  emit('update:expanded', !isExpanded.value);
}
</script>

<template>
  <section
    class="lc-collapsible-block"
    :class="[`is-${kind}`, { 'is-expanded': isExpanded, 'is-empty': !collapsible }]"
  >
    <div class="lc-collapsible-header" :class="{ 'has-actions': $slots.actions, 'has-trail': $slots.trail }">
      <button
        type="button"
        class="lc-collapsible-summary"
        :aria-expanded="isExpanded"
        :aria-label="ariaLabel"
        @click="toggleExpanded"
      >
        <IconChevronRight
          class="lc-collapsible-chevron lc-collapse-chevron"
          :class="{ 'is-expanded': isExpanded }"
          stroke="2"
          aria-hidden="true"
        />
        <span class="lc-collapsible-icon" :class="{ 'is-active': iconActive }" aria-hidden="true">
          <slot name="icon" />
        </span>
        <span class="lc-collapsible-main">
          <slot name="summary" />
        </span>
      </button>
      <span v-if="$slots.actions" class="lc-collapsible-actions" @click.stop @keydown.stop>
        <slot name="actions" />
      </span>
      <button
        v-if="$slots.trail"
        type="button"
        class="lc-collapsible-trail"
        :aria-expanded="isExpanded"
        :aria-label="ariaLabel"
        @click="toggleExpanded"
      >
        <slot name="trail" />
      </button>
    </div>

    <div
      v-if="$slots.default && collapsible"
      class="lc-collapsible-content-shell lc-collapse-shell"
      :class="{ 'is-expanded': isExpanded }"
      :aria-hidden="!isExpanded"
    >
      <div class="lc-collapsible-content-frame lc-collapse-frame">
        <slot />
      </div>
    </div>
  </section>
</template>

<style scoped>
.lc-collapsible-block {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.lc-collapsible-header {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: stretch;
}

.lc-collapsible-summary {
  width: auto;
  flex: 1 1 0;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  padding: 4px 7px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  gap: 6px;
  color: inherit;
  background: var(--lc-content-input-background);
  cursor: pointer;
  text-align: left;
  line-height: 1.6;
  font: inherit;
  appearance: none;
  user-select: none;
  -webkit-user-select: none;
}

.lc-collapsible-block.is-output .lc-collapsible-summary {
  background: var(--lc-content-output-background);
}

.lc-collapsible-header.has-actions .lc-collapsible-summary,
.lc-collapsible-header.has-trail .lc-collapsible-summary {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right-width: 0;
}

.lc-collapsible-actions {
  flex: 0 1 auto;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  padding: 0 4px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  border-radius: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--vscode-descriptionForeground);
  background: var(--lc-content-input-background);
  font-size: var(--font-size-xs);
}

.lc-collapsible-header.has-actions:not(.has-trail) .lc-collapsible-actions {
  border-top-right-radius: var(--radius-sm);
  border-bottom-right-radius: var(--radius-sm);
}

.lc-collapsible-header.has-actions.has-trail .lc-collapsible-actions {
  border-right-width: 0;
}

.lc-collapsible-block.is-output .lc-collapsible-actions {
  background: var(--lc-content-output-background);
}

.lc-collapsible-summary:hover,
.lc-collapsible-summary:focus-visible {
  color: var(--vscode-foreground);
  background: var(--lc-content-input-background);
}

.lc-collapsible-summary:active {
  background: var(--lc-content-input-background);
}

.lc-collapsible-block.is-output .lc-collapsible-summary:hover,
.lc-collapsible-block.is-output .lc-collapsible-summary:focus-visible,
.lc-collapsible-block.is-output .lc-collapsible-summary:active {
  background: var(--lc-content-output-background);
}

.lc-collapsible-summary:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 2px;
}

.lc-collapsible-block.is-empty .lc-collapsible-summary {
  cursor: default;
}

.lc-collapsible-block.is-empty .lc-collapsible-chevron {
  opacity: 0.45;
}

.lc-collapsible-chevron,
.lc-collapsible-icon {
  width: 14px;
  height: 14px;
  color: var(--lc-content-icon-color);
  flex: 0 0 auto;
}

.lc-collapsible-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.lc-collapsible-icon :deep(svg) {
  width: 14px;
  height: 14px;
  display: block;
}

.lc-collapsible-summary:hover .lc-collapsible-chevron,
.lc-collapsible-summary:focus-visible .lc-collapsible-chevron,
.lc-collapsible-summary:hover .lc-collapsible-icon:not(.is-active),
.lc-collapsible-summary:focus-visible .lc-collapsible-icon:not(.is-active) {
  color: currentColor;
}

.lc-collapsible-icon.is-active {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.lc-collapsible-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
}

.lc-collapsible-trail {
  flex: 0 1 auto;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  padding: 4px 7px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--vscode-descriptionForeground);
  background: var(--lc-content-input-background);
  cursor: pointer;
  text-align: left;
  line-height: 1.6;
  font: inherit;
  font-size: var(--font-size-xs);
  appearance: none;
  user-select: none;
  -webkit-user-select: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.lc-collapsible-block.is-output .lc-collapsible-trail {
  background: var(--lc-content-output-background);
}

.lc-collapsible-trail:hover,
.lc-collapsible-trail:focus-visible {
  color: var(--vscode-foreground);
  background: var(--lc-content-input-background);
}

.lc-collapsible-block.is-output .lc-collapsible-trail:hover,
.lc-collapsible-block.is-output .lc-collapsible-trail:focus-visible,
.lc-collapsible-block.is-output .lc-collapsible-trail:active {
  background: var(--lc-content-output-background);
}

.lc-collapsible-trail:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 2px;
}

.lc-collapsible-block.is-empty .lc-collapsible-trail {
  cursor: default;
}
</style>
