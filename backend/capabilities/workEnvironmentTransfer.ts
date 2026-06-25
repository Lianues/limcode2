import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { WorkEnvironmentRecord } from '../../shared/protocol';
import {
  isLocalFolderWorkEnvironment,
  isRemoteServerWorkEnvironment,
  workEnvironmentDisplayName
} from '../../shared/workEnvironmentCatalog';
import type {
  CommandRunObserver,
  WorkEnvironmentRuntimeCapability,
  WorkEnvironmentTransferContext,
  WorkEnvironmentTransferItem,
  WorkEnvironmentTransferResult,
  WorkEnvironmentTransferVerifyMode
} from './types';
import {
  executeRemoteServerScript,
  openRemoteServerReadStream,
  openRemoteServerWriteStream,
  remoteProjectRootPath,
  resolveRemotePath,
  shQuote
} from './workEnvironmentProvider';

const STREAM_HIGH_WATER_MARK = 1024 * 1024;
const PROGRESS_THROTTLE_MS = 1000;

type TransferKind = 'auto' | 'file' | 'directory';
type ResolvedKind = 'file' | 'directory';

interface StatInfo {
  type: ResolvedKind;
  size: number;
}

interface DirEntry {
  name: string;
  type: ResolvedKind;
  size?: number;
}

interface StreamHandle {
  stream: Readable | Writable;
  done?: () => Promise<void>;
}

interface Endpoint {
  environment: WorkEnvironmentRecord;
  resolvePath(input: string, policy: TransferPathPolicy): string;
  normalize(p: string): string;
  dirname(p: string): string;
  basename(p: string): string;
  join(dir: string, child: string): string;
  stat(p: string): Promise<StatInfo>;
  exists(p: string): Promise<boolean>;
  mkdirp(p: string): Promise<void>;
  readdir(p: string): Promise<DirEntry[]>;
  unlink(p: string): Promise<void>;
  rename(src: string, dst: string, overwrite: boolean): Promise<void>;
  openRead(p: string): Promise<StreamHandle & { stream: Readable }>;
  openWrite(p: string, overwrite: boolean): Promise<StreamHandle & { stream: Writable }>;
}

interface TransferPathPolicy {
  allowOutsideProjectPaths: boolean;
}


interface TransferProgressTracker {
  observer?: CommandRunObserver;
  startedAt: number;
  prevReportTs: number;
  prevReportBytes: number;
  lastSpeed: number;
  totalBytes: number;
  totalFiles: number;
  totalKnown: boolean;
  transferredBytes: number;
  completedFiles: number;
  currentSourcePath?: string;
  currentTargetPath?: string;
  lastReportTs: number;
}

interface NormalizedTransferItem extends WorkEnvironmentTransferItem {
  type: TransferKind;
  overwrite: boolean;
  createDirs: boolean;
}

export function createWorkEnvironmentRuntimeCapability(): WorkEnvironmentRuntimeCapability {
  return {
    transferFiles(args, observer, context) {
      return transferFiles(args, observer, context ?? {});
    }
  };
}

async function transferFiles(
  args: { transfers?: WorkEnvironmentTransferItem[]; verify?: WorkEnvironmentTransferVerifyMode },
  observer: CommandRunObserver | undefined,
  context: WorkEnvironmentTransferContext
): Promise<WorkEnvironmentTransferResult> {
  const items = normalizeTransfers(args);
  if (items.length === 0) throw new Error('transfer: 请提供 transfers 数组，且每项包含 fromEnvironment/fromPath/toEnvironment/toPath。');
  const verify: WorkEnvironmentTransferVerifyMode = args.verify === 'none' ? 'none' : 'size';
  const results: WorkEnvironmentTransferResult['results'] = [];
  let successCount = 0;
  let failCount = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const started = Date.now();
    try {
      const result = await runTransfer(item, verify, observer, context, index);
      results.push({ ...result, durationMs: Date.now() - started });
      successCount += 1;
    } catch (error) {
      results.push({
        success: false,
        index,
        type: item.type,
        from: { environment: item.fromEnvironment, path: item.fromPath },
        to: { environment: item.toEnvironment, path: item.toPath },
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started
      });
      failCount += 1;
    }
  }

  return { results, successCount, failCount, totalCount: items.length };
}

function normalizeTransfers(args: { transfers?: WorkEnvironmentTransferItem[] }): NormalizedTransferItem[] {
  const rawList = Array.isArray(args.transfers) ? args.transfers : [];
  const result: NormalizedTransferItem[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const fromEnvironment = normalizeString(raw.fromEnvironment);
    const fromPath = normalizeString(raw.fromPath);
    const toEnvironment = normalizeString(raw.toEnvironment);
    const toPath = normalizeString(raw.toPath);
    if (!fromEnvironment || !fromPath || !toEnvironment || !toPath) continue;
    const type = raw.type === 'file' || raw.type === 'directory' ? raw.type : 'auto';
    result.push({
      fromEnvironment,
      fromPath,
      toEnvironment,
      toPath,
      type,
      overwrite: raw.overwrite === true,
      createDirs: raw.createDirs !== false
    });
  }
  return result;
}

async function runTransfer(
  item: NormalizedTransferItem,
  verify: WorkEnvironmentTransferVerifyMode,
  observer: CommandRunObserver | undefined,
  context: WorkEnvironmentTransferContext,
  index: number
): Promise<WorkEnvironmentTransferResult['results'][number]> {
  const from = createEndpoint(resolveEnvironment(item.fromEnvironment, context));
  const to = createEndpoint(resolveEnvironment(item.toEnvironment, context));
  const pathPolicy: TransferPathPolicy = { allowOutsideProjectPaths: context.allowOutsideProjectPaths !== false };

  const sourcePath = from.resolvePath(item.fromPath, pathPolicy);
  let targetPath = to.resolvePath(item.toPath, pathPolicy);
  const sourceStat = await from.stat(sourcePath);
  const kind: ResolvedKind = item.type === 'auto'
    ? (hasTrailingSlash(item.fromPath) ? 'directory' : sourceStat.type)
    : item.type;

  if (kind === 'file' && hasTrailingSlash(item.toPath)) targetPath = to.join(targetPath, from.basename(sourcePath));

  if (kind === 'file') {
    const tracker = createTransferTracker(observer, { files: 1, bytes: sourceStat.size }, true);
    reportTransferProgress(tracker, false, true);
    const copied = await copyFile({ from, to, sourcePath, targetPath, overwrite: item.overwrite, createDirs: item.createDirs, verify, tracker, knownSize: sourceStat.size });
    reportTransferProgress(tracker, true, true);
    return {
      success: true,
      index,
      type: 'file',
      from: { environment: item.fromEnvironment, path: item.fromPath },
      to: { environment: item.toEnvironment, path: item.toPath },
      files: 1,
      dirs: 0,
      bytes: copied.bytes,
      verify: { mode: verify, ok: copied.verifyOk },
      durationMs: 0
    };
  }

  const tracker = createTransferTracker(observer, { files: 0, bytes: 0 }, false);
  reportTransferProgress(tracker, false, true);
  const copied = await copyDirectory({ from, to, sourceDir: sourcePath, targetDir: targetPath, overwrite: item.overwrite, createDirs: item.createDirs, verify, tracker, mkdirCache: new Set<string>() });
  reportTransferProgress(tracker, true, true);
  return {
    success: true,
    index,
    type: 'directory',
    from: { environment: item.fromEnvironment, path: item.fromPath },
    to: { environment: item.toEnvironment, path: item.toPath },
    files: copied.files,
    dirs: copied.dirs,
    bytes: copied.bytes,
    verify: { mode: verify, ok: copied.verifyOk },
    durationMs: 0
  };
}

function resolveEnvironment(selector: string, context: WorkEnvironmentTransferContext): WorkEnvironmentRecord {
  if (selector === 'current' || selector === 'active') {
    if (!context.activeWorkEnvironment) throw new Error('当前没有 active 工作环境。');
    return context.activeWorkEnvironment;
  }
  const candidates = context.availableWorkEnvironments ?? [];
  const found = candidates.find((environment) => environment.id === selector || environment.name === selector);
  if (!found) throw new Error(`未知或当前策略不允许使用工作环境：${selector}`);
  return found;
}

function createEndpoint(environment: WorkEnvironmentRecord): Endpoint {
  if (isLocalFolderWorkEnvironment(environment)) return new LocalEndpoint(environment);
  if (isRemoteServerWorkEnvironment(environment)) return new RemoteCommandEndpoint(environment);
  throw new Error(`工作环境 ${workEnvironmentDisplayName(environment)} (${environment.kind}) 暂未接入文件传输 provider。`);
}

async function copyDirectory(input: {
  from: Endpoint;
  to: Endpoint;
  sourceDir: string;
  targetDir: string;
  overwrite: boolean;
  createDirs: boolean;
  verify: WorkEnvironmentTransferVerifyMode;
  tracker: TransferProgressTracker;
  mkdirCache: Set<string>;
}): Promise<{ files: number; dirs: number; bytes: number; verifyOk: boolean }> {
  const { from, to, sourceDir, targetDir, overwrite, createDirs, verify, tracker, mkdirCache } = input;
  if (createDirs) await mkdirpCached(to, targetDir, mkdirCache);
  const entries = await from.readdir(sourceDir);
  let files = 0;
  let dirs = 1;
  let bytes = 0;
  let verifyOk = true;

  for (const entry of entries) {
    const childSource = from.join(sourceDir, entry.name);
    const childTarget = to.join(targetDir, entry.name);
    if (entry.type === 'directory') {
      const nested = await copyDirectory({ from, to, sourceDir: childSource, targetDir: childTarget, overwrite, createDirs, verify, tracker, mkdirCache });
      files += nested.files;
      dirs += nested.dirs;
      bytes += nested.bytes;
      verifyOk = verifyOk && nested.verifyOk;
    } else {
      const copied = await copyFile({ from, to, sourcePath: childSource, targetPath: childTarget, overwrite, createDirs, verify, tracker, knownSize: entry.size, mkdirCache });
      files += 1;
      bytes += copied.bytes;
      verifyOk = verifyOk && copied.verifyOk;
    }
  }
  return { files, dirs, bytes, verifyOk };
}

async function copyFile(input: {
  from: Endpoint;
  to: Endpoint;
  sourcePath: string;
  targetPath: string;
  overwrite: boolean;
  createDirs: boolean;
  verify: WorkEnvironmentTransferVerifyMode;
  tracker: TransferProgressTracker;
  knownSize?: number;
  mkdirCache?: Set<string>;
}): Promise<{ bytes: number; verifyOk: boolean }> {
  const { from, to, sourcePath, targetPath, overwrite, createDirs, verify, tracker, knownSize, mkdirCache } = input;
  const sourceSize = knownSize !== undefined ? knownSize : (await from.stat(sourcePath)).size;
  if (!overwrite && await to.exists(targetPath)) throw new Error(`目标已存在: ${targetPath}`);
  if (createDirs) {
    const dir = to.dirname(targetPath);
    if (mkdirCache) await mkdirpCached(to, dir, mkdirCache);
    else await to.mkdirp(dir);
  }
  const tempPath = makeTempPath(to, targetPath);
  tracker.currentSourcePath = sourcePath;
  tracker.currentTargetPath = targetPath;
  try {
    await copyFileViaStream(from, to, sourcePath, tempPath, tracker);
    let verifyOk = true;
    if (verify === 'size') {
      const tempStat = await to.stat(tempPath);
      verifyOk = tempStat.type === 'file' && tempStat.size === sourceSize;
      if (!verifyOk) throw new Error(`size 校验失败: source=${sourceSize}, temp=${tempStat.size}`);
    }
    await to.rename(tempPath, targetPath, overwrite);
    tracker.completedFiles += 1;
    reportTransferProgress(tracker, false, true);
    return { bytes: sourceSize, verifyOk };
  } catch (error) {
    await safeUnlink(to, tempPath);
    throw error;
  }
}

async function copyFileViaStream(from: Endpoint, to: Endpoint, sourcePath: string, tempPath: string, tracker: TransferProgressTracker): Promise<void> {
  const progress = new Transform({
    highWaterMark: STREAM_HIGH_WATER_MARK,
    transform(chunk, _encoding, callback) {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      tracker.transferredBytes += size;
      callback(null, chunk);
    }
  });
  const reader = await from.openRead(sourcePath);
  const writer = await to.openWrite(tempPath, false);
  const timer = setInterval(() => reportTransferProgress(tracker, false, true), PROGRESS_THROTTLE_MS);
  try {
    await pipeline(reader.stream, progress, writer.stream);
    if (reader.done) await reader.done();
    if (writer.done) await writer.done();
  } finally {
    clearInterval(timer);
  }
}

function createTransferTracker(observer: CommandRunObserver | undefined, stats: { files: number; bytes: number }, totalKnown: boolean): TransferProgressTracker {
  const now = Date.now();
  return {
    observer,
    startedAt: now,
    prevReportTs: now,
    prevReportBytes: 0,
    lastSpeed: 0,
    totalBytes: stats.bytes,
    totalFiles: stats.files,
    totalKnown,
    transferredBytes: 0,
    completedFiles: 0,
    lastReportTs: 0
  };
}

function reportTransferProgress(tracker: TransferProgressTracker, final: boolean, force: boolean): void {
  const now = Date.now();
  if (!force && now - tracker.lastReportTs < PROGRESS_THROTTLE_MS) return;
  tracker.lastReportTs = now;
  const elapsedMs = Math.max(1, now - tracker.startedAt);
  const dt = now - tracker.prevReportTs;
  const db = tracker.transferredBytes - tracker.prevReportBytes;
  let speedBytesPerSec = tracker.lastSpeed;
  if (final) speedBytesPerSec = tracker.transferredBytes / (elapsedMs / 1000);
  else if (dt >= 500 && db > 0) {
    speedBytesPerSec = db / (dt / 1000);
    tracker.lastSpeed = speedBytesPerSec;
    tracker.prevReportTs = now;
    tracker.prevReportBytes = tracker.transferredBytes;
  }
  const percent = final
    ? 100
    : tracker.totalKnown && tracker.totalBytes > 0
      ? Math.min(99, Math.round((tracker.transferredBytes / tracker.totalBytes) * 100))
      : -1;
  tracker.observer?.onEvent?.({
    kind: 'progress',
    payload: {
      kind: 'transfer',
      sourcePath: tracker.currentSourcePath,
      targetPath: tracker.currentTargetPath,
      bytesTransferred: tracker.transferredBytes,
      totalBytes: tracker.totalKnown ? tracker.totalBytes : undefined,
      percent,
      speedBytesPerSec,
      elapsedMs,
      filesTransferred: tracker.completedFiles,
      totalFiles: tracker.totalKnown ? tracker.totalFiles : undefined
    }
  });
}

async function mkdirpCached(endpoint: Endpoint, p: string, cache: Set<string>): Promise<void> {
  const normalized = endpoint.normalize(p);
  if (cache.has(normalized)) return;
  await endpoint.mkdirp(normalized);
  let current = normalized;
  while (current && current !== '/' && current !== '.' && !cache.has(current)) {
    cache.add(current);
    const parent = endpoint.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function makeTempPath(endpoint: Endpoint, targetPath: string): string {
  const dir = endpoint.dirname(targetPath);
  const base = endpoint.basename(targetPath) || 'target';
  const suffix = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  return endpoint.join(dir, `.${base}.work-env-tmp-${suffix}`);
}

async function safeUnlink(endpoint: Endpoint, p: string): Promise<void> {
  try { await endpoint.unlink(p); } catch { /* ignore cleanup errors */ }
}

function hasTrailingSlash(p: string): boolean {
  return /[\\/]$/.test(p);
}

function trimTrailingSeparators(p: string, isRemote: boolean): string {
  const root = isRemote ? '/' : path.parse(p).root;
  let out = p;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function localProjectRootPath(environment: WorkEnvironmentRecord): string | undefined {
  const rootPath = normalizeString(environment.rootPath);
  if (rootPath) return path.resolve(rootPath);
  const uri = normalizeString(environment.uri);
  if (!uri) return undefined;
  if (uri.startsWith('file:')) {
    try { return path.resolve(fileURLToPath(uri)); }
    catch { return undefined; }
  }
  return path.resolve(uri);
}

function isAbsoluteLocalPath(input: string): boolean {
  return path.isAbsolute(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input);
}

function relativeLocalPath(input: string): string {
  return input.replace(/[\\/]+/g, path.sep);
}

function canonicalLocalPath(input: string): string {
  const normalized = path.resolve(input);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertLocalPathInsideRoot(candidate: string, root: string): void {
  const normalizedCandidate = canonicalLocalPath(candidate);
  const normalizedRoot = canonicalLocalPath(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`路径超出当前本地工作环境根目录：${candidate}（root=${root}）`);
}


class LocalEndpoint implements Endpoint {
  public constructor(public environment: WorkEnvironmentRecord) {}
  resolvePath(input: string, policy: TransferPathPolicy): string {
    const text = normalizeString(input);
    if (!text) throw new Error('本地路径不能为空。');
    const root = localProjectRootPath(this.environment);
    const resolved = isAbsoluteLocalPath(text)
      ? this.normalize(text)
      : root
        ? path.resolve(root, relativeLocalPath(text))
        : undefined;
    if (!resolved) throw new Error(`本地工作环境缺少 rootPath，无法解析相对路径: ${text}`);
    const normalized = this.normalize(resolved);
    if (!policy.allowOutsideProjectPaths) {
      if (!root) throw new Error(`本地工作环境缺少 rootPath，无法限制项目外路径：${workEnvironmentDisplayName(this.environment)}`);
      assertLocalPathInsideRoot(normalized, root);
    }
    return normalized;
  }
  normalize(p: string): string { return path.normalize(trimTrailingSeparators(p, false)); }
  dirname(p: string): string { return path.dirname(p); }
  basename(p: string): string { return path.basename(p); }
  join(dir: string, child: string): string { return path.join(dir, child); }
  async stat(p: string): Promise<StatInfo> {
    const st = await fsp.stat(p);
    if (st.isDirectory()) return { type: 'directory', size: 0 };
    if (st.isFile()) return { type: 'file', size: st.size };
    throw new Error(`不支持的本地路径类型: ${p}`);
  }
  async exists(p: string): Promise<boolean> { try { await fsp.stat(p); return true; } catch { return false; } }
  async mkdirp(p: string): Promise<void> { await fsp.mkdir(p, { recursive: true }); }
  async readdir(p: string): Promise<DirEntry[]> {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) out.push({ name: entry.name, type: 'directory' });
      else if (entry.isFile()) out.push({ name: entry.name, type: 'file', size: (await fsp.stat(full)).size });
    }
    return out;
  }
  async unlink(p: string): Promise<void> { await fsp.rm(p, { force: true }); }
  async rename(src: string, dst: string, overwrite: boolean): Promise<void> {
    if (overwrite) await fsp.rm(dst, { force: true });
    await fsp.rename(src, dst);
  }
  async openRead(p: string): Promise<StreamHandle & { stream: Readable }> {
    return { stream: fs.createReadStream(p, { highWaterMark: STREAM_HIGH_WATER_MARK }) };
  }
  async openWrite(p: string, overwrite: boolean): Promise<StreamHandle & { stream: Writable }> {
    return { stream: fs.createWriteStream(p, { flags: overwrite ? 'w' : 'wx', highWaterMark: STREAM_HIGH_WATER_MARK }) };
  }
}

class RemoteCommandEndpoint implements Endpoint {
  public constructor(public environment: WorkEnvironmentRecord) {}
  resolvePath(input: string, policy: TransferPathPolicy): string {
    const text = normalizeString(input);
    if (!text) throw new Error('远端路径不能为空。');
    const isAbsolute = text.replace(/\\/g, '/').startsWith('/');
    const root = remoteProjectRootPath(this.environment);
    if (!isAbsolute && !root) throw new Error(`远程工作环境缺少 workdir/rootPath，无法解析相对路径: ${text}`);
    return this.normalize(resolveRemotePath(text, this.environment, undefined, {
      allowOutsideProjectPaths: policy.allowOutsideProjectPaths
    }));
  }
  normalize(p: string): string { return path.posix.normalize(trimTrailingSeparators(p.replace(/\\/g, '/'), true)); }
  dirname(p: string): string { return path.posix.dirname(p); }
  basename(p: string): string { return path.posix.basename(p); }
  join(dir: string, child: string): string { return path.posix.join(dir, child); }
  async stat(p: string): Promise<StatInfo> {
    const script = `if [ -d ${shQuote(p)} ]; then printf 'directory\t0'; elif [ -f ${shQuote(p)} ]; then printf 'file\t%s' "$(wc -c < ${shQuote(p)})"; else echo 'path not found' >&2; exit 44; fi`;
    const result = await executeRemoteServerScript(this.environment, script, { timeout: 30_000, displayCommand: `stat ${p}` });
    assertExecOk(result, `stat ${p}`);
    const [type, size] = result.stdout.trim().split('\t');
    if (type === 'directory') return { type: 'directory', size: 0 };
    if (type === 'file') return { type: 'file', size: Number.parseInt(size, 10) || 0 };
    throw new Error(`无法识别远端路径类型: ${p}`);
  }
  async exists(p: string): Promise<boolean> {
    const result = await executeRemoteServerScript(this.environment, `[ -e ${shQuote(p)} ]`, { timeout: 30_000, displayCommand: `exists ${p}` });
    return result.exitCode === 0;
  }
  async mkdirp(p: string): Promise<void> {
    const result = await executeRemoteServerScript(this.environment, `mkdir -p -- ${shQuote(p)}`, { timeout: 30_000, displayCommand: `mkdir -p ${p}` });
    assertExecOk(result, `mkdir -p ${p}`);
  }
  async readdir(p: string): Promise<DirEntry[]> {
    const script = `cd -- ${shQuote(p)} && for x in ./* ./.??* ./.?*; do [ -e "$x" ] || continue; name="\${x#./}"; if [ -d "$x" ]; then printf 'd\t%s\t0\0' "$name"; elif [ -f "$x" ]; then size="$(wc -c < "$x" 2>/dev/null || printf '0')"; printf 'f\t%s\t%s\0' "$name" "$size"; fi; done | base64 | tr -d '\n\r'`;
    const result = await executeRemoteServerScript(this.environment, script, { timeout: 30_000, displayCommand: `readdir ${p}` });
    assertExecOk(result, `readdir ${p}`);
    return decodeNulListFromBase64(result.stdout).map((record) => {
      const [type, name, size] = record.split('\t');
      if (!name) return undefined;
      return { name, type: type === 'd' ? 'directory' : 'file', ...(type === 'f' ? { size: Number.parseInt(size ?? '0', 10) || 0 } : {}) } as DirEntry;
    }).filter((entry): entry is DirEntry => !!entry);
  }
  async unlink(p: string): Promise<void> {
    const result = await executeRemoteServerScript(this.environment, `rm -f -- ${shQuote(p)}`, { timeout: 30_000, displayCommand: `rm ${p}` });
    assertExecOk(result, `rm -f ${p}`);
  }
  async rename(src: string, dst: string, overwrite: boolean): Promise<void> {
    const script = overwrite
      ? `mv -f -- ${shQuote(src)} ${shQuote(dst)}`
      : `if [ -e ${shQuote(dst)} ]; then echo 'target exists' >&2; exit 17; fi; mv -- ${shQuote(src)} ${shQuote(dst)}`;
    const result = await executeRemoteServerScript(this.environment, script, { timeout: 30_000, displayCommand: `rename ${src}` });
    assertExecOk(result, `rename ${src} -> ${dst}`);
  }
  async openRead(p: string): Promise<StreamHandle & { stream: Readable }> {
    const handle = openRemoteServerReadStream(this.environment, p);
    return { stream: handle.stdout, done: async () => assertExecOk(await handle.done, `cat ${p}`) };
  }
  async openWrite(p: string, _overwrite: boolean): Promise<StreamHandle & { stream: Writable }> {
    const handle = openRemoteServerWriteStream(this.environment, p);
    return { stream: handle.stdin, done: async () => assertExecOk(await handle.done, `write ${p}`) };
  }
}

function assertExecOk(result: { exitCode: number; killed: boolean; stderr: string }, op: string): void {
  if (result.exitCode !== 0 || result.killed) throw new Error(`${op} 失败: exitCode=${result.exitCode} stderr=${result.stderr}`);
}

function decodeNulListFromBase64(stdout: string): string[] {
  const text = Buffer.from(stdout.replace(/\s+/g, ''), 'base64').toString('utf8');
  return text.split('\0').filter(Boolean);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
