import type { MessageRecord } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { staticToolScheduling } from '../../scheduling';
import { defineToolDefinitionModule } from '../types';

interface ReadConversationArgs { conversationId?: string; lastN?: number; messageIds?: string[] }

export const readConversationToolModule = defineToolDefinitionModule({ id: 'read_conversation', create() { return readConversationTool; } });

export const readConversationTool: ToolDefinition = {
  declaration: {
    name: 'read_conversation',
    description: 'Read messages from a saved LimCode conversation by conversationId. Returns a compact read-only transcript excerpt.',
    parameters: { type: 'object', properties: { conversationId: { type: 'string' }, lastN: { type: 'number' }, messageIds: { type: 'array', items: { type: 'string' } } }, required: ['conversationId'] },
    metadata: { category: 'general', riskLevel: 'read', readonly: true, defaultEnabled: true }
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'readonly_conversation_read'),
  async execute(rawArgs, deps) {
    const args = (rawArgs ?? {}) as ReadConversationArgs;
    const conversationId = args.conversationId?.trim();
    if (!conversationId) return { ok: false, output: 'Missing required argument: conversationId' };
    const detail = await deps.storage.loadConversationDetail(conversationId, { includeRunHistory: false });
    if (!detail) return { ok: false, output: `Conversation not found: ${conversationId}` };
    const ids = new Set(args.messageIds ?? []);
    let messages = detail.messages.sort((a, b) => a.seq - b.seq);
    if (ids.size > 0) messages = messages.filter((message) => ids.has(message.id));
    else if (args.lastN !== undefined) messages = messages.slice(-Math.max(1, Math.min(200, Math.floor(args.lastN))));
    return { ok: true, output: { conversationId, messages: messages.map(renderMessage) } };
  }
};

function renderMessage(message: MessageRecord): { id: string; role: string; text: string; createdAt: number } {
  const text = message.content.parts.map((part) => {
    if ('text' in part && part.thought !== true) return part.text;
    if ('functionCall' in part) return `[function_call ${part.functionCall.name}]`;
    if ('functionResponse' in part) return `[function_response ${part.functionResponse.name}]`;
    return '';
  }).filter(Boolean).join('\n');
  return { id: message.id, role: message.role, text: text.slice(0, 12000), createdAt: message.createdAt };
}
