import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  AttachmentRecord,
  AttachmentSettingsRecord,
  ClientState,
  ContentPart,
  FunctionResponsePart,
  InlineDataPart,
  MessageContent,
  MessageRecord,
  MessageRevisionRecord
} from '../../../shared/protocol';
import { isFunctionResponsePart, isInlineDataPart } from '../../../shared/protocol';
import { STORAGE_VERSION } from './constants';
import type { StoragePaths } from './clientStateStore';
import { loadGlobalSettingsFile } from './globalSettings';
import { loadRecordStore, loadRecordStoreByIds, upsertRecordStoreRecords } from './recordStore';
import { readJson, writeJson } from './json';

const ATTACHMENT_RECORD_KEY = 'attachment';
const ATTACHMENT_BLOBS_DIR = 'blobs';
const ATTACHMENT_OPENED_DIR = 'opened';
const DEFAULT_MAX_STORED_INLINE_FILE_MB = 20;

interface AttachmentBlobFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  attachmentId: string;
  mimeType: string;
  name?: string;
  data: string;
}

interface ExternalizeContext {
  maxStoredBytes: number;
  cache: Map<string, AttachmentRecord>;
}

export interface AttachmentInlineDataInput {
  mimeType: string;
  data: string;
  name?: string;
}

export interface ResolvedAttachmentInlineData {
  part: InlineDataPart;
  status: 'available' | 'missing' | 'failed';
  error?: string;
}

export async function loadAttachmentSettings(paths: StoragePaths): Promise<AttachmentSettingsRecord> {
  const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'attachments');
  const record = stored.settings as Partial<AttachmentSettingsRecord> | undefined;
  const number = Number(record?.maxStoredInlineFileMb);
  return {
    maxStoredInlineFileMb: Number.isFinite(number)
      ? Math.min(200, Math.max(1, Math.floor(number)))
      : DEFAULT_MAX_STORED_INLINE_FILE_MB
  };
}

export async function saveManagedAttachment(paths: StoragePaths, input: AttachmentInlineDataInput): Promise<AttachmentRecord> {
  const data = sanitizeBase64(input.data);
  const bytes = Buffer.from(data, 'base64');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const id = `attachment-${sha256.slice(0, 24)}`;
  const now = Date.now();
  const blobFile = `${ATTACHMENT_BLOBS_DIR}/${sha256}.base64.json`;
  const existing = (await loadAttachmentRecordsByIds(paths, [id]))[0];
  const record: AttachmentRecord = {
    id,
    mimeType: input.mimeType,
    ...(input.name ? { name: input.name } : existing?.name ? { name: existing.name } : {}),
    sizeBytes: bytes.byteLength,
    base64Bytes: Buffer.byteLength(data, 'utf8'),
    sha256,
    blobFile: existing?.blobFile ?? blobFile,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  await ensureAttachmentRoots(paths);
  await writeJson(vscode.Uri.joinPath(paths.attachmentsRootUri, ...record.blobFile.split('/')), {
    schemaVersion: STORAGE_VERSION,
    savedAt: new Date(now).toISOString(),
    attachmentId: id,
    mimeType: input.mimeType,
    ...(input.name ? { name: input.name } : {}),
    data
  } satisfies AttachmentBlobFile);
  await upsertRecordStoreRecords(paths.attachmentsRootUri, paths.attachmentsIndexUri, [record], ATTACHMENT_RECORD_KEY, (item) => item.name ?? item.mimeType ?? item.id);
  return record;
}

export async function loadAttachmentRecords(paths: StoragePaths): Promise<AttachmentRecord[]> {
  return await loadRecordStore<AttachmentRecord, typeof ATTACHMENT_RECORD_KEY>(paths.attachmentsRootUri, paths.attachmentsIndexUri, ATTACHMENT_RECORD_KEY) ?? [];
}

export async function loadAttachmentRecordsByIds(paths: StoragePaths, ids: Iterable<string>): Promise<AttachmentRecord[]> {
  return loadRecordStoreByIds<AttachmentRecord, typeof ATTACHMENT_RECORD_KEY>(paths.attachmentsRootUri, paths.attachmentsIndexUri, ATTACHMENT_RECORD_KEY, ids);
}

export async function loadManagedAttachmentData(paths: StoragePaths, attachmentId: string): Promise<InlineDataPart | undefined> {
  const id = attachmentId.trim();
  if (!id) return undefined;
  const record = (await loadAttachmentRecordsByIds(paths, [id]))[0];
  if (!record) return undefined;
  const blob = await readJson<AttachmentBlobFile>(vscode.Uri.joinPath(paths.attachmentsRootUri, ...record.blobFile.split('/')));
  if (!blob || blob.schemaVersion !== STORAGE_VERSION || blob.attachmentId !== id || typeof blob.data !== 'string') return undefined;
  return {
    inlineData: {
      mimeType: blob.mimeType || record.mimeType,
      data: blob.data,
      ...(blob.name || record.name ? { name: blob.name ?? record.name } : {}),
      attachmentId: id,
      storage: 'managed',
      status: 'available',
      sizeBytes: record.sizeBytes
    }
  };
}

export async function externalizeClientStateAttachments(paths: StoragePaths, state: ClientState): Promise<ClientState> {
  const settings = await loadAttachmentSettings(paths);
  const context: ExternalizeContext = {
    maxStoredBytes: settings.maxStoredInlineFileMb * 1024 * 1024,
    cache: new Map()
  };
  const messages = await Promise.all(state.messages.map((message) => externalizeMessageRecord(paths, message, context)));
  const messageRevisions = await Promise.all(state.messageRevisions.map((revision) => externalizeMessageRevisionRecord(paths, revision, context)));
  return {
    ...state,
    messages,
    messageRevisions
  };
}

export function markClientStateAttachmentsForClient(state: ClientState): ClientState {
  state.messages = state.messages.map((message) => ({ ...message, content: markContentAttachmentsForClient(message.content) }));
  state.messageRevisions = state.messageRevisions.map((revision) => ({ ...revision, content: markContentAttachmentsForClient(revision.content) }));
  return state;
}

export async function resolveAttachmentForClient(paths: StoragePaths, input: { attachmentId?: string; sourcePath?: string; mimeType?: string; name?: string }): Promise<ResolvedAttachmentInlineData> {
  if (input.attachmentId?.trim()) {
    try {
      const part = await loadManagedAttachmentData(paths, input.attachmentId);
      if (part) return { part, status: 'available' };
      return { part: unavailableInlineData(input, 'missing', '附件文件不存在'), status: 'missing', error: '附件文件不存在' };
    } catch (error) {
      const message = errorMessage(error);
      return { part: unavailableInlineData(input, 'failed', message), status: 'failed', error: message };
    }
  }

  if (input.sourcePath?.trim()) {
    try {
      const uri = vscode.Uri.file(input.sourcePath.trim());
      const data = await vscode.workspace.fs.readFile(uri);
      return {
        part: {
          inlineData: {
            mimeType: input.mimeType || 'application/octet-stream',
            data: Buffer.from(data).toString('base64'),
            ...(input.name ? { name: input.name } : { name: path.basename(uri.fsPath) }),
            sourcePath: uri.fsPath,
            storage: 'localPath',
            status: 'available',
            sizeBytes: data.byteLength
          }
        },
        status: 'available'
      };
    } catch (error) {
      const message = errorMessage(error);
      return { part: unavailableInlineData(input, 'missing', message), status: 'missing', error: message };
    }
  }

  return { part: unavailableInlineData(input, 'missing', '缺少附件引用'), status: 'missing', error: '缺少附件引用' };
}

export async function materializeAttachmentFileUri(paths: StoragePaths, input: { attachmentId?: string; sourcePath?: string; mimeType?: string; name?: string }): Promise<vscode.Uri | undefined> {
  if (input.sourcePath?.trim()) return vscode.Uri.file(input.sourcePath.trim());
  if (!input.attachmentId?.trim()) return undefined;
  const resolved = await resolveAttachmentForClient(paths, input);
  const data = resolved.part?.inlineData.data;
  if (!data) return undefined;
  const fileName = safeAttachmentFileName(input.attachmentId, resolved.part.inlineData.name ?? input.name, resolved.part.inlineData.mimeType);
  const uri = vscode.Uri.joinPath(paths.attachmentsRootUri, ATTACHMENT_OPENED_DIR, fileName);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(paths.attachmentsRootUri, ATTACHMENT_OPENED_DIR));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'base64'));
  return uri;
}

export async function ensureAttachmentRoots(paths: StoragePaths): Promise<void> {
  await Promise.all([
    vscode.workspace.fs.createDirectory(paths.attachmentsRootUri),
    vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(paths.attachmentsRootUri, ATTACHMENT_BLOBS_DIR))
  ]);
}

async function externalizeMessageRecord(paths: StoragePaths, message: MessageRecord, context: ExternalizeContext): Promise<MessageRecord> {
  return { ...message, content: await externalizeContentAttachments(paths, message.content, context) };
}

async function externalizeMessageRevisionRecord(paths: StoragePaths, revision: MessageRevisionRecord, context: ExternalizeContext): Promise<MessageRevisionRecord> {
  return { ...revision, content: await externalizeContentAttachments(paths, revision.content, context) };
}

async function externalizeContentAttachments(paths: StoragePaths, content: MessageContent, context: ExternalizeContext): Promise<MessageContent> {
  const parts = await Promise.all(content.parts.map((part) => externalizePartAttachments(paths, part, context)));
  return { ...content, parts };
}

async function externalizePartAttachments(paths: StoragePaths, part: ContentPart, context: ExternalizeContext): Promise<ContentPart> {
  if (isInlineDataPart(part)) return externalizeInlineDataPart(paths, part, context);
  if (isFunctionResponsePart(part)) return externalizeFunctionResponsePart(paths, part, context);
  return part;
}

async function externalizeFunctionResponsePart(paths: StoragePaths, part: FunctionResponsePart, context: ExternalizeContext): Promise<FunctionResponsePart> {
  const parts = part.functionResponse.parts;
  if (!parts?.length) return part;
  const nextParts = await Promise.all(parts.map((inlinePart) => externalizeInlineDataPart(paths, inlinePart, context)));
  return {
    ...part,
    functionResponse: {
      ...part.functionResponse,
      parts: nextParts
    }
  };
}

async function externalizeInlineDataPart(paths: StoragePaths, part: InlineDataPart, context: ExternalizeContext): Promise<InlineDataPart> {
  const data = part.inlineData.data;
  if (!data) return stripRuntimeStatus(part);
  const base64Bytes = Buffer.byteLength(data, 'utf8');
  const rawBytes = Math.floor(base64Bytes * 0.75);

  if (rawBytes > context.maxStoredBytes) {
    if (part.inlineData.sourcePath) {
      return {
        inlineData: {
          mimeType: part.inlineData.mimeType,
          ...(part.inlineData.name ? { name: part.inlineData.name } : {}),
          sourcePath: part.inlineData.sourcePath,
          storage: 'localPath',
          status: 'available',
          sizeBytes: rawBytes
        }
      };
    }
    return {
      inlineData: {
        mimeType: part.inlineData.mimeType,
        ...(part.inlineData.name ? { name: part.inlineData.name } : {}),
        storage: 'embedded',
        status: 'tooLarge',
        error: `附件超过托管阈值 ${Math.floor(context.maxStoredBytes / 1024 / 1024)}MB，且没有可恢复的本地路径。`,
        sizeBytes: rawBytes
      }
    };
  }

  const cacheKey = `${part.inlineData.mimeType}\n${part.inlineData.name ?? ''}\n${data}`;
  const cached = context.cache.get(cacheKey);
  const record = cached ?? await saveManagedAttachment(paths, { mimeType: part.inlineData.mimeType, data, name: part.inlineData.name });
  context.cache.set(cacheKey, record);
  return {
    inlineData: {
      mimeType: record.mimeType,
      ...(record.name ? { name: record.name } : part.inlineData.name ? { name: part.inlineData.name } : {}),
      attachmentId: record.id,
      storage: 'managed',
      status: 'available',
      sizeBytes: record.sizeBytes
    }
  };
}

function markContentAttachmentsForClient(content: MessageContent): MessageContent {
  return { ...content, parts: content.parts.map(markPartAttachmentsForClient) };
}

function markPartAttachmentsForClient(part: ContentPart): ContentPart {
  if (isInlineDataPart(part)) return markInlineDataPartForClient(part);
  if (isFunctionResponsePart(part) && part.functionResponse.parts?.length) {
    return {
      ...part,
      functionResponse: {
        ...part.functionResponse,
        parts: part.functionResponse.parts.map(markInlineDataPartForClient)
      }
    };
  }
  return part;
}

function markInlineDataPartForClient(part: InlineDataPart): InlineDataPart {
  const inlineData = part.inlineData;
  if (inlineData.data) return { inlineData: { ...inlineData, status: inlineData.status ?? 'available' } };
  if (inlineData.attachmentId) return { inlineData: { ...inlineData, storage: inlineData.storage ?? 'managed', status: inlineData.status ?? 'loading' } };
  if (inlineData.sourcePath) return { inlineData: { ...inlineData, storage: inlineData.storage ?? 'localPath', status: inlineData.status ?? 'available' } };
  return { inlineData: { ...inlineData, status: inlineData.status ?? 'missing' } };
}

function stripRuntimeStatus(part: InlineDataPart): InlineDataPart {
  const inlineData = part.inlineData;
  return {
    inlineData: {
      mimeType: inlineData.mimeType,
      ...(inlineData.name ? { name: inlineData.name } : {}),
      ...(inlineData.attachmentId ? { attachmentId: inlineData.attachmentId } : {}),
      ...(inlineData.sourcePath ? { sourcePath: inlineData.sourcePath } : {}),
      ...(inlineData.storage ? { storage: inlineData.storage } : {}),
      ...(inlineData.status ? { status: inlineData.status } : {}),
      ...(inlineData.error ? { error: inlineData.error } : {}),
      ...(inlineData.sizeBytes !== undefined ? { sizeBytes: inlineData.sizeBytes } : {})
    }
  };
}

function unavailableInlineData(input: { attachmentId?: string; sourcePath?: string; mimeType?: string; name?: string }, status: 'missing' | 'failed', error: string): InlineDataPart {
  return {
    inlineData: {
      mimeType: input.mimeType || 'application/octet-stream',
      ...(input.name ? { name: input.name } : {}),
      ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
      ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
      storage: input.attachmentId ? 'managed' : input.sourcePath ? 'localPath' : undefined,
      status,
      error
    }
  };
}

function sanitizeBase64(value: string): string {
  return value.replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
}

function safeAttachmentFileName(id: string, name: string | undefined, mimeType: string): string {
  const baseName = name?.trim() || `attachment${extensionForMimeType(mimeType)}`;
  const safe = baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || `attachment${extensionForMimeType(mimeType)}`;
  return `${id.replace(/[^a-zA-Z0-9_.-]+/g, '-')}-${safe}`;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'application/pdf': return '.pdf';
    case 'text/plain': return '.txt';
    default: return '';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
