import * as vscode from 'vscode';
import type { StoragePaths } from './clientStateStore';
import type { ConversationCompressionGenerationRef } from './compressionStore';
import type { ConversationTimelineGenerationRef } from './conversationTimelineStore';
import { readJsonStrict, writeJson } from './json';
import { isSafeStorageGenerationId } from './storageGeneration';
import { withStorageResourceLock } from './storageResourceLock';

const CONVERSATION_DETAILS_DIR = 'details';
const TIMELINE_COMMIT_FILE = 'timeline-commit.json';
const TIMELINE_COMMIT_KIND = 'conversationTimeline.commit';

interface StoredConversationTimelineCommitRecord {
  kind: typeof TIMELINE_COMMIT_KIND;
  conversationId: string;
  commitSeq: number;
  committedAt: number;
  timeline?: ConversationTimelineGenerationRef;
  compression?: ConversationCompressionGenerationRef;
}

export interface ConversationTimelineCommitStamp {
  commitSeq: number;
  committedAt: number;
}

/** 根提交文件唯一指向的一组 timeline/compression 不可变快照。 */
export interface ConversationTimelineCommittedSnapshot extends ConversationTimelineCommitStamp {
  timeline?: ConversationTimelineGenerationRef;
  compression?: ConversationCompressionGenerationRef;
}

export interface PreparedConversationTimelineCommit<T> {
  value: T;
  timeline?: ConversationTimelineGenerationRef;
  compression?: ConversationCompressionGenerationRef;
}

export interface ConversationTimelineCommitResult<T> extends ConversationTimelineCommittedSnapshot {
  value: T;
}

export interface ConversationTimelineCommitTestHooks {
  /** 测试专用：所有不可变子快照准备完成后、根提交指针原子发布前触发。 */
  beforeCommitWrite?: (record: Readonly<StoredConversationTimelineCommitRecord>) => void | Promise<void>;
}

export const __conversationTimelineCommitTestHooks: ConversationTimelineCommitTestHooks = {};

/**
 * 在 conversation timeline+compression 的统一提交锁内准备不可变子快照，最后只用一个
 * 根提交文件原子发布完整 pair。任何子写入失败、根指针写入失败或进程在发布前退出，
 * reader 都仍只会读取上一次 committed pair；未引用 generation 仅作为可清理 orphan 存在。
 */
export async function commitConversationTimelineMutation<T>(
  paths: StoragePaths,
  conversationId: string,
  action: (previous: Readonly<ConversationTimelineCommittedSnapshot>) => Promise<PreparedConversationTimelineCommit<T>>
): Promise<ConversationTimelineCommitResult<T>> {
  const uri = conversationTimelineCommitUri(paths, conversationId);
  return withStorageResourceLock(uri, async () => {
    const previous = await readConversationTimelineCommitUnlocked(uri, conversationId);
    const prepared = await action(previous);
    const next: StoredConversationTimelineCommitRecord = {
      kind: TIMELINE_COMMIT_KIND,
      conversationId,
      commitSeq: previous.commitSeq + 1,
      committedAt: Date.now(),
      ...(prepared.timeline ? { timeline: prepared.timeline } : {}),
      ...(prepared.compression ? { compression: prepared.compression } : {})
    };
    await __conversationTimelineCommitTestHooks.beforeCommitWrite?.(next);
    await writeJson(uri, next);
    return {
      value: prepared.value,
      commitSeq: next.commitSeq,
      committedAt: next.committedAt,
      ...(next.timeline ? { timeline: next.timeline } : {}),
      ...(next.compression ? { compression: next.compression } : {})
    };
  });
}

/**
 * 在同一根提交锁内读取 manifest 指定的 immutable pair。action 不允许再解析各子 store
 * 的“当前 index”，只能按传入 ref 读取，避免失败提交留下的 orphan 被误认为 committed。
 */
export async function readConversationTimelineCommittedSnapshot<T>(
  paths: StoragePaths,
  conversationId: string,
  action: (snapshot: Readonly<ConversationTimelineCommittedSnapshot>) => Promise<T>
): Promise<ConversationTimelineCommitResult<T>> {
  const uri = conversationTimelineCommitUri(paths, conversationId);
  return withStorageResourceLock(uri, async () => {
    const snapshot = await readConversationTimelineCommitUnlocked(uri, conversationId);
    const value = await action(snapshot);
    return { value, ...snapshot };
  });
}

function conversationTimelineCommitUri(paths: StoragePaths, conversationId: string): vscode.Uri {
  return vscode.Uri.joinPath(
    paths.conversationsRootUri,
    CONVERSATION_DETAILS_DIR,
    safeShardName(conversationId),
    TIMELINE_COMMIT_FILE
  );
}

async function readConversationTimelineCommitUnlocked(
  uri: vscode.Uri,
  conversationId: string
): Promise<ConversationTimelineCommittedSnapshot> {
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'missing') return { commitSeq: 0, committedAt: 0 };
  if (result.status !== 'ok') throw result.error;
  if (!isStoredConversationTimelineCommitRecord(result.value, conversationId)) {
    throw new Error(`Conversation timeline commit record is invalid: ${uri.fsPath}`);
  }
  return {
    commitSeq: result.value.commitSeq,
    committedAt: result.value.committedAt,
    ...(result.value.timeline ? { timeline: result.value.timeline } : {}),
    ...(result.value.compression ? { compression: result.value.compression } : {})
  };
}

function isStoredConversationTimelineCommitRecord(
  value: unknown,
  conversationId: string
): value is StoredConversationTimelineCommitRecord {
  if (!isPlainObject(value)) return false;
  const record = value as Partial<StoredConversationTimelineCommitRecord>;
  const keys = Object.keys(value);
  if (keys.some((key) => !['kind', 'conversationId', 'commitSeq', 'committedAt', 'timeline', 'compression'].includes(key))) return false;
  return record.kind === TIMELINE_COMMIT_KIND
    && record.conversationId === conversationId
    && Number.isSafeInteger(record.commitSeq)
    && (record.commitSeq ?? -1) >= 0
    && Number.isSafeInteger(record.committedAt)
    && (record.committedAt ?? -1) >= 0
    && (record.timeline === undefined || isTimelineGenerationRef(record.timeline))
    && (record.compression === undefined || isCompressionGenerationRef(record.compression));
}

function isTimelineGenerationRef(value: unknown): value is ConversationTimelineGenerationRef {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['generation', 'revision'])) return false;
  return typeof value.generation === 'string'
    && isSafeStorageGenerationId(value.generation)
    && typeof value.revision === 'string'
    && !!value.revision;
}

function isCompressionGenerationRef(value: unknown): value is ConversationCompressionGenerationRef {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['generation', 'stores'])) return false;
  if (typeof value.generation !== 'string' || !isSafeStorageGenerationId(value.generation)) return false;
  const generation = value.generation;
  if (!isPlainObject(value.stores) || !hasOnlyKeys(value.stores, ['blocks', 'sourceLinks', 'variants', 'invocationLinks', 'invocations'])) return false;
  return Object.values(value.stores).every((ref) => isRecordStoreGenerationRef(ref, generation));
}

function isRecordStoreGenerationRef(value: unknown, generation: string): boolean {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['generation', 'revision'])) return false;
  return value.generation === generation && typeof value.revision === 'string' && !!value.revision;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function safeShardName(id: string): string {
  const slug = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'conversation';
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
