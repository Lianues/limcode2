<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { IconMessageQuestion } from '@tabler/icons-vue';
import { ASK_USER_MAX_CUSTOM_ANSWER_LENGTH, askUserOptionKey, askUserOutputFromResult } from '@shared/askUser';
import type { AskUserOptionRecord, AskUserToolRequestRecord, ToolCallRecord } from '@shared/protocol';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import LcCheckbox from '@webview/components/ui/LcCheckbox.vue';
import { useAskUserStore, type AskUserDraftState } from '@webview/stores/useAskUserStore';

const props = withDefaults(defineProps<{
  request: AskUserToolRequestRecord;
  toolCall?: ToolCallRecord;
  placement?: 'tool-detail' | 'composer';
}>(), {
  placement: 'tool-detail'
});

const askUser = useAskUserStore();
const optionsRoot = ref<HTMLElement | null>(null);
const customInput = ref<HTMLTextAreaElement | null>(null);
const toolCallId = computed(() => props.toolCall?.id ?? '');
const draft = computed<AskUserDraftState>(() => toolCallId.value ? askUser.draftFor(toolCallId.value) : emptyDraft());
const output = computed(() => askUserOutputFromResult(props.toolCall?.result));
const answeredOptionKeys = computed(() => new Set((output.value?.selectedOptions ?? []).map(askUserOptionKey)));
const pending = computed(() => props.toolCall?.status === 'awaiting_user_input');
const submitting = computed(() => pending.value && draft.value.submitting);
const interactive = computed(() => pending.value && !submitting.value && !!toolCallId.value);
const customSelected = computed(() => output.value ? !!output.value.customText : draft.value.customSelected);
const customText = computed(() => output.value?.customText ?? draft.value.customText);
const canSubmit = computed(() => pending.value
  && !submitting.value
  && (!draft.value.customSelected || draft.value.customText.trim().length > 0)
  && (draft.value.selectedOptionIndexes.length > 0 || draft.value.customSelected)
);
const selectionModeLabel = computed(() => props.request.multiple ? '可多选' : '单选');
const statusLabel = computed(() => {
  if (!props.toolCall) return '正在准备问题';
  if (submitting.value) return draft.value.submittingAction === 'cancel' ? '正在取消问题' : '正在提交回答';
  if (pending.value) return props.placement === 'tool-detail' ? '等待你的回答 · 与输入框上方同步' : '等待你的回答';
  if (output.value) return '已回答';
  if (props.toolCall.status === 'error') return '问题已取消';
  return '问题已结束';
});

watch(
  () => `${props.toolCall?.id ?? ''}:${props.toolCall?.status ?? ''}`,
  () => {
    const call = props.toolCall;
    if (call && call.status !== 'awaiting_user_input') askUser.clearDraft(call.id);
  },
  { immediate: true }
);

function optionSelected(option: AskUserOptionRecord, optionIndex: number): boolean {
  return output.value
    ? answeredOptionKeys.value.has(askUserOptionKey(option))
    : draft.value.selectedOptionIndexes.includes(optionIndex);
}

function activeSingleChoiceIndex(): number {
  if (customSelected.value) return props.request.options.length;
  const selected = props.request.options.findIndex((option, index) => optionSelected(option, index));
  return selected >= 0 ? selected : 0;
}

function choiceTabIndex(index: number): number | undefined {
  return props.request.multiple ? undefined : activeSingleChoiceIndex() === index ? 0 : -1;
}

function moveSingleChoice(event: KeyboardEvent, currentIndex: number, delta: number): void {
  if (props.request.multiple || !interactive.value) return;
  event.preventDefault();
  const choiceCount = props.request.options.length + 1;
  const nextIndex = (currentIndex + delta + choiceCount) % choiceCount;
  if (nextIndex === props.request.options.length) askUser.toggleCustom(toolCallId.value, false);
  else askUser.toggleOption(toolCallId.value, nextIndex, false);
  void nextTick(() => optionsRoot.value
    ?.querySelector<HTMLButtonElement>(`[data-ask-user-choice-index="${nextIndex}"]`)
    ?.focus());
}

function toggleOption(optionIndex: number): void {
  if (!interactive.value) return;
  askUser.toggleOption(toolCallId.value, optionIndex, props.request.multiple);
}

function toggleCustom(): void {
  if (!interactive.value) return;
  const willSelect = !props.request.multiple || !draft.value.customSelected;
  askUser.toggleCustom(toolCallId.value, props.request.multiple);
  if (willSelect) void nextTick(() => customInput.value?.focus());
}

function updateCustomText(event: Event): void {
  if (!interactive.value) return;
  const target = event.target as HTMLTextAreaElement | null;
  askUser.setCustomText(toolCallId.value, target?.value ?? '', props.request.multiple);
}

function submit(): void {
  if (!toolCallId.value || !pending.value) return;
  askUser.submit(toolCallId.value, props.request);
}

function cancel(): void {
  if (!toolCallId.value || !interactive.value) return;
  askUser.cancel(toolCallId.value);
}

function submitFromTextarea(event: KeyboardEvent): void {
  if (!canSubmit.value) return;
  event.preventDefault();
  submit();
}

function emptyDraft(): AskUserDraftState {
  return { selectedOptionIndexes: [], customSelected: false, customText: '', submitting: false };
}
</script>

<template>
  <section
    class="ask-user-content"
    :class="[`placement-${placement}`, { 'is-pending': pending, 'is-submitting': submitting, 'is-answered': !!output }]"
    :aria-label="statusLabel"
  >
    <header class="ask-user-heading">
      <IconMessageQuestion class="ask-user-heading-icon" stroke="2" aria-hidden="true" />
      <span class="ask-user-heading-label">{{ statusLabel }}</span>
      <span class="ask-user-selection-mode">{{ selectionModeLabel }}</span>
    </header>

    <p class="ask-user-question">{{ request.question }}</p>

    <div ref="optionsRoot" class="ask-user-options" :role="request.multiple ? 'group' : 'radiogroup'" :aria-label="request.question">
      <button
        v-for="(option, optionIndex) in request.options"
        :key="`option-${optionIndex}-${option.label}`"
        type="button"
        class="ask-user-option"
        :class="{ 'is-selected': optionSelected(option, optionIndex) }"
        :role="request.multiple ? 'checkbox' : 'radio'"
        :aria-checked="optionSelected(option, optionIndex)"
        :data-ask-user-choice-index="optionIndex"
        :tabindex="choiceTabIndex(optionIndex)"
        :disabled="!interactive"
        @click="toggleOption(optionIndex)"
        @keydown.arrow-down="moveSingleChoice($event, optionIndex, 1)"
        @keydown.arrow-right="moveSingleChoice($event, optionIndex, 1)"
        @keydown.arrow-up="moveSingleChoice($event, optionIndex, -1)"
        @keydown.arrow-left="moveSingleChoice($event, optionIndex, -1)"
      >
        <LcCheckbox
          v-if="request.multiple"
          class="ask-user-option-check"
          presentation
          size="sm"
          :model-value="optionSelected(option, optionIndex)"
          :disabled="!interactive"
        />
        <span v-else class="ask-user-option-marker" aria-hidden="true">
          <span class="ask-user-option-marker-dot"></span>
        </span>
        <span class="ask-user-option-copy">
          <span class="ask-user-option-label">{{ option.label }}</span>
          <span v-if="option.description" class="ask-user-option-description">{{ option.description }}</span>
        </span>
      </button>

      <div class="ask-user-custom" :class="{ 'is-selected': customSelected }">
        <button
          type="button"
          class="ask-user-option ask-user-custom-toggle"
          :class="{ 'is-selected': customSelected }"
          :role="request.multiple ? 'checkbox' : 'radio'"
          :aria-checked="customSelected"
          :data-ask-user-choice-index="request.options.length"
          :tabindex="choiceTabIndex(request.options.length)"
          :disabled="!interactive"
          @click="toggleCustom"
          @keydown.arrow-down="moveSingleChoice($event, request.options.length, 1)"
          @keydown.arrow-right="moveSingleChoice($event, request.options.length, 1)"
          @keydown.arrow-up="moveSingleChoice($event, request.options.length, -1)"
          @keydown.arrow-left="moveSingleChoice($event, request.options.length, -1)"
        >
          <LcCheckbox
            v-if="request.multiple"
            class="ask-user-option-check"
            presentation
            size="sm"
            :model-value="customSelected"
            :disabled="!interactive"
          />
          <span v-else class="ask-user-option-marker" aria-hidden="true">
            <span class="ask-user-option-marker-dot"></span>
          </span>
          <span class="ask-user-option-copy">
            <span class="ask-user-option-label">自己描述</span>
            <span class="ask-user-option-description">
              {{ request.multiple ? '可与其他选项一起提交' : '填写不在上述选项中的回答' }}
            </span>
          </span>
        </button>

        <div v-if="customSelected && pending" class="ask-user-custom-input-shell">
          <textarea
            ref="customInput"
            class="ask-user-custom-input"
            :value="customText"
            :disabled="submitting"
            rows="3"
            :maxlength="ASK_USER_MAX_CUSTOM_ANSWER_LENGTH"
            placeholder="输入你的回答；Ctrl/Cmd + Enter 提交"
            aria-label="自定义回答"
            @input="updateCustomText"
            @keydown.ctrl.enter="submitFromTextarea"
            @keydown.meta.enter="submitFromTextarea"
          ></textarea>
          <AdvancedScrollbar
            class="ask-user-custom-scrollbar"
            :scroller="customInput"
            :refresh-key="customText"
            variant="minimal"
          />
        </div>
        <p v-else-if="output?.customText" class="ask-user-custom-answer">{{ output.customText }}</p>
      </div>
    </div>

    <p v-if="draft.error && pending" class="ask-user-error" role="alert">{{ draft.error }}</p>

    <footer v-if="pending" class="ask-user-actions">
      <button type="button" class="ask-user-action secondary" :disabled="submitting" @click="cancel">
        {{ submitting && draft.submittingAction === 'cancel' ? '正在取消…' : '取消提问' }}
      </button>
      <button type="button" class="ask-user-action primary" :disabled="!canSubmit" @click="submit">
        {{ submitting && draft.submittingAction === 'answer' ? '正在提交…' : '提交回答' }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.ask-user-content {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
}

.ask-user-content.placement-composer {
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, var(--vscode-foreground) 18%);
  border-radius: 0;
  padding: 10px;
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-foreground) 5%);
  box-shadow: none;
}

.ask-user-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--vscode-descriptionForeground);
}

.ask-user-heading-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
}

.ask-user-heading-label {
  min-width: 0;
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.ask-user-selection-mode {
  flex: 0 0 auto;
  margin-left: auto;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  padding: 1px 5px;
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
  font-size: var(--font-size-xs);
  line-height: 1.35;
}

.ask-user-question {
  margin: 0;
  color: var(--vscode-foreground);
  font-size: var(--font-size-md, 14px);
  font-weight: 600;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ask-user-options {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.ask-user-option {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: 0;
  padding: 7px 9px;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
  box-shadow: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ask-user-option:hover:not(:disabled),
.ask-user-option:focus-visible:not(:disabled) {
  border-color: color-mix(in srgb, var(--vscode-foreground) 38%, var(--vscode-panel-border) 62%);
  background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
  outline: none;
}

.ask-user-option.is-selected {
  border-color: color-mix(in srgb, var(--vscode-foreground) 48%, var(--vscode-panel-border) 52%);
  background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-foreground) 14%);
  box-shadow: none;
}

.ask-user-option:disabled {
  cursor: default;
  opacity: 0.72;
}

.ask-user-option.is-selected:disabled {
  opacity: 1;
}

.ask-user-option-check {
  align-self: center;
  margin-top: 0;
}

.ask-user-option-marker {
  align-self: center;
  width: 14px;
  height: 14px;
  margin-top: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 74%, transparent);
  border-radius: 50%;
}

.ask-user-option.is-selected .ask-user-option-marker {
  border-color: var(--vscode-foreground);
}

.ask-user-option-marker-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
}

.ask-user-option.is-selected .ask-user-option-marker-dot {
  background: var(--vscode-foreground);
}

.ask-user-option-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ask-user-option-label {
  font-weight: 500;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.ask-user-option-description {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.ask-user-custom {
  min-width: 0;
}

.ask-user-custom-toggle {
  position: relative;
  z-index: 1;
}

.ask-user-custom-input-shell {
  position: relative;
  margin-top: 5px;
  min-height: 74px;
}

.ask-user-custom-input {
  width: 100%;
  min-height: 74px;
  max-height: 124px;
  resize: vertical;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
  border-radius: 0;
  padding: 8px 20px 8px 9px;
  color: var(--vscode-input-foreground, var(--vscode-foreground));
  background: var(--vscode-input-background, var(--vscode-editor-background));
  font: inherit;
  line-height: 1.45;
  scrollbar-width: none;
  box-sizing: border-box;
}

.ask-user-custom-input::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.ask-user-custom-input:focus {
  border-color: color-mix(in srgb, var(--vscode-foreground) 48%, var(--vscode-panel-border) 52%);
  outline: none;
}

.ask-user-custom-scrollbar {
  inset: 2px 2px 2px auto;
}

.ask-user-custom-answer {
  margin: 5px 0 0;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, var(--vscode-foreground) 18%);
  border-radius: 0;
  padding: 5px 8px;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ask-user-error {
  margin: 0;
  color: var(--vscode-errorForeground, #f14c4c);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.ask-user-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 7px;
}

.ask-user-action {
  appearance: none;
  -webkit-appearance: none;
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
  border-radius: 0;
  padding: 4px 10px;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.ask-user-action:hover:not(:disabled),
.ask-user-action:focus-visible:not(:disabled) {
  border-color: color-mix(in srgb, var(--vscode-foreground) 42%, var(--vscode-panel-border) 58%);
  background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-foreground) 20%);
  outline: none;
}

.ask-user-action.secondary {
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.ask-user-action:disabled {
  cursor: default;
  opacity: 0.48;
}
</style>
