import * as vscode from 'vscode';
import type { ClientState, CompressionBlockLlmInvocationLinkRecord, CompressionBlockRecord, CompressionBlockSourceLinkRecord, CompressionContextVariantRecord, LlmInvocationRecord } from '../../../shared/protocol';
import { createEmptyClientState } from '../../../shared/clientStateSchema';
import { INDEX_FILE } from './constants';
import type { StoragePaths } from './clientStateStore';
import { loadRecordStore, saveRecordStore } from './recordStore';

const CONVERSATIONS_DIR = 'conversations';

export async function loadConversationCompressionDetail(paths: StoragePaths, conversationId: string): Promise<ClientState | undefined> {
  const state = createEmptyClientState();
  const blocks = await loadRecordStore<CompressionBlockRecord, 'block'>(conversationScopedRoot(paths.compressionBlocksRootUri, conversationId), conversationScopedIndex(paths.compressionBlocksRootUri, conversationId), 'block') ?? [];
  state.compressionBlocks = blocks.filter((block) => block.conversationId === conversationId);
  const blockIds = new Set(state.compressionBlocks.map((block) => block.id));
  const links = await loadRecordStore<CompressionBlockSourceLinkRecord, 'link'>(conversationScopedRoot(paths.compressionBlockSourceLinksRootUri, conversationId), conversationScopedIndex(paths.compressionBlockSourceLinksRootUri, conversationId), 'link') ?? [];
  state.compressionBlockSourceLinks = links.filter((link) => blockIds.has(link.blockId));
  const variants = await loadRecordStore<CompressionContextVariantRecord, 'variant'>(conversationScopedRoot(paths.compressionContextVariantsRootUri, conversationId), conversationScopedIndex(paths.compressionContextVariantsRootUri, conversationId), 'variant') ?? [];
  state.compressionContextVariants = variants.filter((variant) => blockIds.has(variant.blockId));
  const invocationLinks = await loadRecordStore<CompressionBlockLlmInvocationLinkRecord, 'link'>(conversationScopedRoot(paths.compressionBlockLlmInvocationLinksRootUri, conversationId), conversationScopedIndex(paths.compressionBlockLlmInvocationLinksRootUri, conversationId), 'link') ?? [];
  state.compressionBlockLlmInvocationLinks = invocationLinks.filter((link) => blockIds.has(link.blockId));
  const invocationIds = new Set(state.compressionBlockLlmInvocationLinks.map((link) => link.invocationId));
  const invocations = await loadRecordStore<LlmInvocationRecord, 'invocation'>(conversationScopedRoot(paths.compressionLlmInvocationsRootUri, conversationId), conversationScopedIndex(paths.compressionLlmInvocationsRootUri, conversationId), 'invocation') ?? [];
  state.llmInvocations = invocations.filter((invocation) => invocationIds.has(invocation.id));
  return state.compressionBlocks.length || state.compressionBlockSourceLinks.length || state.compressionContextVariants.length || state.compressionBlockLlmInvocationLinks.length || state.llmInvocations.length ? state : undefined;
}

export async function saveConversationCompressionDetail(paths: StoragePaths, conversationId: string, state: ClientState): Promise<void> {
  const blocks = state.compressionBlocks.filter((block) => block.conversationId === conversationId);
  const blockIds = new Set(blocks.map((block) => block.id));
  const links = state.compressionBlockSourceLinks.filter((link) => blockIds.has(link.blockId));
  const variants = state.compressionContextVariants.filter((variant) => blockIds.has(variant.blockId));
  const invocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => blockIds.has(link.blockId));
  const invocationIds = new Set(invocationLinks.map((link) => link.invocationId));
  const invocations = state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id));
  await Promise.all([
    saveRecordStore(conversationScopedRoot(paths.compressionBlocksRootUri, conversationId), conversationScopedIndex(paths.compressionBlocksRootUri, conversationId), blocks, 'block', (record) => record.title || record.id),
    saveRecordStore(conversationScopedRoot(paths.compressionBlockSourceLinksRootUri, conversationId), conversationScopedIndex(paths.compressionBlockSourceLinksRootUri, conversationId), links, 'link'),
    saveRecordStore(conversationScopedRoot(paths.compressionContextVariantsRootUri, conversationId), conversationScopedIndex(paths.compressionContextVariantsRootUri, conversationId), variants, 'variant'),
    saveRecordStore(conversationScopedRoot(paths.compressionBlockLlmInvocationLinksRootUri, conversationId), conversationScopedIndex(paths.compressionBlockLlmInvocationLinksRootUri, conversationId), invocationLinks, 'link'),
    saveRecordStore(conversationScopedRoot(paths.compressionLlmInvocationsRootUri, conversationId), conversationScopedIndex(paths.compressionLlmInvocationsRootUri, conversationId), invocations, 'invocation')
  ]);
}

function conversationScopedRoot(root: vscode.Uri, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(root, CONVERSATIONS_DIR, safeShardName(conversationId));
}

function conversationScopedIndex(root: vscode.Uri, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(conversationScopedRoot(root, conversationId), INDEX_FILE);
}

function safeShardName(id: string): string {
  const slug = id.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'conversation';
  return `${slug}-${shortHash(id)}`;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
