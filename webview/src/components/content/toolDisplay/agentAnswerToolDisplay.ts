import { IconUsers } from '@tabler/icons-vue';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';

export const readAgentAnswerToolDisplay: ToolDisplayResolver = (context) => {
  const answer = answerFromValue(context.result);
  if (!answer?.content) {
    return { headerIcon: IconUsers };
  }

  return {
    headerIcon: IconUsers,
    outputSections: [answerMarkdownSection(answer.title ?? '回答正文', answer.content)]
  };
};

export const submitAgentAnswerToolDisplay: ToolDisplayResolver = (context) => {
  const args = answerFromValue(context.args);
  const result = answerSubmitResult(context.result);
  const inputSections: ToolDisplaySection[] = [];

  if (args?.title || args?.answerBridgeId) {
    inputSections.push({
      kind: 'input',
      title: '提交信息',
      rows: [
        ...(args.answerBridgeId ? [{ label: 'answerBridgeId', value: args.answerBridgeId }] : []),
        ...(args.title ? [{ label: 'title', value: args.title }] : [])
      ],
      rowStyle: 'keyValue'
    });
  }
  if (args?.content) inputSections.push(answerMarkdownSection('提交回答正文', args.content, 'input'));

  return {
    headerIcon: IconUsers,
    ...(inputSections.length > 0 ? { inputSections } : {}),
    ...(result ? {
      outputSections: [{
        kind: 'output',
        title: '提交结果',
        rows: [
          { label: 'ok', value: String(result.ok) },
          ...(result.answerBridgeId ? [{ label: 'answerBridgeId', value: result.answerBridgeId }] : []),
          ...(result.updated !== undefined ? [{ label: 'updated', value: String(result.updated) }] : [])
        ],
        rowStyle: 'keyValue'
      }]
    } : {})
  };
};

export function answerMarkdownSection(title: string, content: string, kind: 'input' | 'output' = 'output'): ToolDisplaySection {
  return { kind, title, text: content, markdown: true };
}

export function answerFromValue(value: unknown): { answerBridgeId?: string; title?: string; content?: string } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const nestedAnswer = asRecord(record.answer);
  const source = nestedAnswer ?? record;
  const answerBridgeId = stringValue(source.answerBridgeId);
  const title = stringValue(source.title);
  const content = stringValue(source.content) ?? stringValue(source.result);
  return answerBridgeId || title || content ? { ...(answerBridgeId ? { answerBridgeId } : {}), ...(title ? { title } : {}), ...(content ? { content } : {}) } : undefined;
}

function answerSubmitResult(value: unknown): { ok?: boolean; answerBridgeId?: string; updated?: boolean } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const answerBridgeId = stringValue(record.answerBridgeId);
  const ok = typeof record.ok === 'boolean' ? record.ok : undefined;
  const updated = typeof record.updated === 'boolean' ? record.updated : undefined;
  return answerBridgeId || ok !== undefined || updated !== undefined ? { ...(ok !== undefined ? { ok } : {}), ...(answerBridgeId ? { answerBridgeId } : {}), ...(updated !== undefined ? { updated } : {}) } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
