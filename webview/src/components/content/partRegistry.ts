import type { Component } from 'vue';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isTextPart,
  type ContentPart,
  type TextPart
} from '@shared/protocol';
import TextPartView from './parts/TextPartView.vue';
import ThoughtPartView from './parts/ThoughtPartView.vue';
import FunctionCallPartView from './parts/FunctionCallPartView.vue';
import FunctionResponsePartView from './parts/FunctionResponsePartView.vue';
import InlineDataPartView from './parts/InlineDataPartView.vue';
import FileDataPartView from './parts/FileDataPartView.vue';

/**
 * 富内容显示子组件注册表。
 *
 * 这里是 ContentPart -> 渲染节点的唯一编排层。它按后端传来的 parts 原始顺序生成节点，
 * MessageItem 不再关心正文、思考、工具、附件之间的排列关系。
 */
export type RichPartKind = 'text' | 'thought' | 'functionCall' | 'functionResponse' | 'inlineData' | 'fileData';

export interface RichRenderNode {
  readonly key: string;
  readonly kind: RichPartKind;
  readonly props: Record<string, unknown>;
}

const COMPONENTS: Record<RichPartKind, Component> = {
  text: TextPartView,
  thought: ThoughtPartView,
  functionCall: FunctionCallPartView,
  functionResponse: FunctionResponsePartView,
  inlineData: InlineDataPartView,
  fileData: FileDataPartView
};

export function partViewComponent(kind: RichPartKind): Component {
  return COMPONENTS[kind];
}

interface TextBuffer {
  kind: 'text' | 'thought';
  startIndex: number;
  endIndex: number;
  parts: TextPart[];
}

/** 把消息 parts 按原始顺序归约为渲染节点。只合并连续同类文本，不跨工具/附件/思考边界重排。 */
export function toRenderNodes(parts: readonly ContentPart[]): RichRenderNode[] {
  const nodes: RichRenderNode[] = [];
  let textBuffer: TextBuffer | undefined;

  const flushTextBuffer = (): void => {
    if (!textBuffer) return;
    const buffer = textBuffer;
    textBuffer = undefined;
    const text = buffer.parts.map((part) => part.text).join('');
    const normalizedText = nodes.length === 0 && buffer.kind === 'text' ? text.trimStart() : text;
    if (!normalizedText.trim()) return;

    if (buffer.kind === 'thought') {
      const durations = buffer.parts
        .map((part) => part.thoughtDurationMs)
        .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration));
      const durationMs = durations.length > 0 ? durations.reduce((sum, duration) => sum + duration, 0) : undefined;
      const thoughtOpen = buffer.parts.some((part) => part.thoughtDurationMs === undefined);
      nodes.push({
        key: `thought:${buffer.startIndex}:${buffer.endIndex}`,
        kind: 'thought',
        props: {
          text: normalizedText.trimEnd(),
          ...(durationMs !== undefined ? { durationMs } : {}),
          thoughtOpen
        }
      });
      return;
    }

    nodes.push({
      key: `text:${buffer.startIndex}:${buffer.endIndex}`,
      kind: 'text',
      props: { text: normalizedText }
    });
  };

  const pushTextPart = (part: TextPart, index: number): void => {
    const kind: TextBuffer['kind'] = part.thought === true ? 'thought' : 'text';
    if (!textBuffer || textBuffer.kind !== kind) {
      flushTextBuffer();
      textBuffer = { kind, startIndex: index, endIndex: index, parts: [part] };
      return;
    }

    textBuffer.endIndex = index;
    textBuffer.parts.push(part);
  };

  parts.forEach((part, index) => {
    if (isTextPart(part)) {
      pushTextPart(part, index);
      return;
    }

    flushTextBuffer();
    if (isFunctionCallPart(part)) {
      nodes.push({ key: `functionCall:${index}:${part.id ?? part.functionCall.name}`, kind: 'functionCall', props: { part, partIndex: index } });
      return;
    }
    if (isFunctionResponsePart(part)) {
      nodes.push({ key: `functionResponse:${index}:${part.id ?? part.functionResponse.name}`, kind: 'functionResponse', props: { part, partIndex: index } });
      return;
    }
    if (isInlineDataPart(part)) {
      nodes.push({ key: `inlineData:${index}:${part.inlineData.mimeType}`, kind: 'inlineData', props: { part, partIndex: index } });
      return;
    }
    if (isFileDataPart(part)) {
      nodes.push({ key: `fileData:${index}:${part.fileData.uri}`, kind: 'fileData', props: { part, partIndex: index } });
    }
  });

  flushTextBuffer();
  return nodes;
}
