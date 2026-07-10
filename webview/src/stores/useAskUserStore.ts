import { defineStore } from 'pinia';
import { resolveAskUserAnswer } from '@shared/askUser';
import type { AskUserAnswerRecord, AskUserToolRequestRecord } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';

export interface AskUserDraftState {
  selectedOptionIndexes: number[];
  customSelected: boolean;
  customText: string;
  submitting: boolean;
  submittingAction?: 'answer' | 'cancel';
  error?: string;
}

interface AskUserStoreState {
  drafts: Record<string, AskUserDraftState>;
}

const submitTimers = new Map<string, number>();
const SUBMIT_CONFIRM_TIMEOUT_MS = 6_000;

export const useAskUserStore = defineStore('askUser', {
  state: (): AskUserStoreState => ({
    drafts: {}
  }),
  actions: {
    draftFor(toolCallId: string): AskUserDraftState {
      return this.drafts[toolCallId] ?? emptyDraft();
    },
    toggleOption(toolCallId: string, optionIndex: number, multiple: boolean): void {
      const current = this.draftFor(toolCallId);
      const selectedOptionIndexes = multiple
        ? toggleIndex(current.selectedOptionIndexes, optionIndex)
        : [optionIndex];
      this.drafts[toolCallId] = {
        ...current,
        selectedOptionIndexes,
        customSelected: multiple ? current.customSelected : false,
        submitting: false,
        submittingAction: undefined,
        error: undefined
      };
    },
    toggleCustom(toolCallId: string, multiple: boolean): void {
      const current = this.draftFor(toolCallId);
      this.drafts[toolCallId] = {
        ...current,
        selectedOptionIndexes: multiple ? current.selectedOptionIndexes : [],
        customSelected: multiple ? !current.customSelected : true,
        submitting: false,
        submittingAction: undefined,
        error: undefined
      };
    },
    setCustomText(toolCallId: string, customText: string, multiple: boolean): void {
      const current = this.draftFor(toolCallId);
      this.drafts[toolCallId] = {
        ...current,
        selectedOptionIndexes: multiple ? current.selectedOptionIndexes : [],
        customSelected: true,
        customText,
        submitting: false,
        submittingAction: undefined,
        error: undefined
      };
    },
    submit(toolCallId: string, request: AskUserToolRequestRecord): boolean {
      const current = this.draftFor(toolCallId);
      if (current.submitting) return false;

      const answer = answerFromDraft(current);
      try {
        resolveAskUserAnswer(request, answer);
      } catch (error) {
        this.drafts[toolCallId] = {
          ...current,
          submitting: false,
          submittingAction: undefined,
          error: answerErrorMessage(error)
        };
        return false;
      }

      this.drafts[toolCallId] = {
        ...current,
        submitting: true,
        submittingAction: 'answer',
        error: undefined
      };
      bridge.request(BridgeMessageType.AskUserAnswerSubmit, {
        toolCallId,
        answer: plainAnswer(answer)
      });
      this.scheduleSubmitTimeout(toolCallId);
      return true;
    },
    cancel(toolCallId: string): void {
      const current = this.draftFor(toolCallId);
      if (current.submitting) return;
      this.drafts[toolCallId] = { ...current, submitting: true, submittingAction: 'cancel', error: undefined };
      bridge.request(BridgeMessageType.ToolExecutionCancel, {
        toolCallId,
        reason: '用户取消了问题。'
      });
      this.scheduleSubmitTimeout(toolCallId);
    },
    clearDraft(toolCallId: string): void {
      const timer = submitTimers.get(toolCallId);
      if (timer !== undefined) window.clearTimeout(timer);
      submitTimers.delete(toolCallId);
      if (!(toolCallId in this.drafts)) return;
      const next = { ...this.drafts };
      delete next[toolCallId];
      this.drafts = next;
    },
    scheduleSubmitTimeout(toolCallId: string): void {
      const existing = submitTimers.get(toolCallId);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        submitTimers.delete(toolCallId);
        const current = this.drafts[toolCallId];
        if (!current?.submitting) return;
        this.drafts[toolCallId] = {
          ...current,
          submitting: false,
          submittingAction: undefined,
          error: current.submittingAction === 'cancel'
            ? '取消暂未得到确认，请重试。'
            : '提交暂未得到确认，请重试。'
        };
      }, SUBMIT_CONFIRM_TIMEOUT_MS);
      submitTimers.set(toolCallId, timer);
    }
  }
});

function emptyDraft(): AskUserDraftState {
  return {
    selectedOptionIndexes: [],
    customSelected: false,
    customText: '',
    submitting: false
  };
}

function toggleIndex(indexes: readonly number[], target: number): number[] {
  const next = indexes.includes(target)
    ? indexes.filter((index) => index !== target)
    : [...indexes, target];
  return next.sort((left, right) => left - right);
}

function answerFromDraft(draft: AskUserDraftState): AskUserAnswerRecord {
  const customText = draft.customSelected ? draft.customText.trim() : '';
  return {
    selectedOptionIndexes: [...draft.selectedOptionIndexes],
    ...(customText ? { customText } : {})
  };
}

function plainAnswer(answer: AskUserAnswerRecord): AskUserAnswerRecord {
  return {
    selectedOptionIndexes: answer.selectedOptionIndexes.map((index) => index),
    ...(answer.customText ? { customText: answer.customText } : {})
  };
}

function answerErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('select at least one option')) return '请至少选择一个选项或填写自己的回答。';
  if (message.includes('single-choice questions')) return '该问题只能选择一个回答。';
  if (message.includes('answer.customText')) return '自定义回答内容无效。';
  if (message.includes('unknown option index')) return '所选选项已经不可用，请重新选择。';
  return '回答内容无效，请检查后重试。';
}
