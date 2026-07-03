import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandCapability, CommandOutputLimits, CommandRunArgs, CommandRunObserver, CommandRunResult, RuntimePaths, WorkEnvironmentCapabilityOptions } from './types';
import {
  WORK_ENVIRONMENT_CAPABILITY,
  isLocalFolderWorkEnvironment,
  workEnvironmentDisplayName,
  workEnvironmentSupportsCapability
} from '../../shared/workEnvironmentCatalog';
import { isRemoteServerCommandEnvironment, runRemoteServerCommand } from './workEnvironmentProvider';

const DEFAULT_TIMEOUT_MS = 30_000;
/** 后台进程完整日志 buffer 的上限（远大于给模型的软上限，避免过早丢弃可能被 output 读取的历史）。 */
const BACKGROUND_MAX_CHARS = 200_000;
/** 兜底的输出上限（调用方未显式传入 limits 时使用）。 */
const DEFAULT_OUTPUT_LIMITS: CommandOutputLimits = { maxOutputLines: 100, maxOutputChars: 10_000 };
const BACKGROUND_COMMAND_RECORDS_DIR = 'records';
const BACKGROUND_COMMAND_STORAGE_VERSION = 1;
const BACKGROUND_PERSIST_DEBOUNCE_MS = 250;
const STREAM_EVENT_FLUSH_INTERVAL_MS = 100;
const STREAM_EVENT_FLUSH_CHARS = 8 * 1024;
const MAX_STREAM_EVENT_DELTA_CHARS = 16 * 1024;
const PS_UTF8_PREFIX = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$PSDefaultParameterValues['*:Encoding'] = 'utf8'",
  ''
].join('; ');

type ShellKind = 'powershell' | 'bash';
type StaticClassification = 'allow' | 'deny' | 'unknown';

interface CommandProfile {
  readonly kind: ShellKind;
  readonly toolName: 'shell' | 'bash';
  readonly executable?: string;
  readonly description: string;
  readonly commandPrefix?: string;
}

interface CommandSafetyConfig {
  safe?: boolean;
  safeSubcommands?: string[];
  isDangerous?: (args: string[]) => boolean;
}

type BackgroundCommandPathsProvider = () => Pick<RuntimePaths, 'backgroundCommandsRootPath' | 'backgroundCommandsIndexPath'>;

interface BackgroundCommandIndexRecord {
  processId: string;
  file: string;
  status: 'running' | 'exited' | 'killed';
  updatedAt: number;
}

interface BackgroundCommandIndexFile {
  version: number;
  records: BackgroundCommandIndexRecord[];
}

interface PersistedBackgroundProcessRecord {
  version: number;
  processId: string;
  kind: ShellKind;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  droppedStdoutChars: number;
  droppedStderrChars: number;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  killed: boolean;
  startedAt: number;
  updatedAt: number;
  exitedAt?: number;
}

/** 一个转入后台运行的命令进程；进程结束后日志持久保留，直到被 output 读取或扩展退出才清理。 */
interface BackgroundProcessHandle {
  processId: string;
  child: ChildProcess;
  kind: ShellKind;
  command: string;
  cwd: string;
  stdout: AppendBuffer;
  stderr: AppendBuffer;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  startedAt: number;
  exitedAt?: number;
  persistTimer?: ReturnType<typeof setTimeout>;
  suppressPersist?: boolean;
}

export function createCommandCapability(capabilityOptions: { paths?: BackgroundCommandPathsProvider } = {}): CommandCapability {
  const profile = detectCommandProfile();
  const registry = new Map<string, BackgroundProcessHandle>();
  const archived = new Map<string, PersistedBackgroundProcessRecord>();
  let persistedLoaded = false;
  const ensurePersistedLoaded = (): void => {
    if (persistedLoaded) return;
    persistedLoaded = true;
    loadPersistedBackgroundRecords(capabilityOptions.paths, archived);
  };
  return {
    toolName: profile.toolName,
    description: profile.description,
    run(args, observer, options, limits) {
      ensurePersistedLoaded();
      return runCommand(profile, registry, archived, capabilityOptions.paths, args, observer, options, limits ?? DEFAULT_OUTPUT_LIMITS);
    },
    readOutput(processId, limits, options) {
      ensurePersistedLoaded();
      return readBackgroundOutput(registry, archived, capabilityOptions.paths, processId, limits ?? DEFAULT_OUTPUT_LIMITS, { consume: options?.consume !== false });
    },
    kill(processId) {
      ensurePersistedLoaded();
      return killBackgroundProcess(registry, archived, capabilityOptions.paths, processId);
    },
    dispose() {
      ensurePersistedLoaded();
      disposeRegistry(registry, capabilityOptions.paths);
    }
  };
}

function generateProcessId(registry: Map<string, BackgroundProcessHandle>, archived: Map<string, PersistedBackgroundProcessRecord>): string {
  let id = '';
  do {
    id = `bg_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  } while (registry.has(id) || archived.has(id));
  return id;
}

function readBackgroundOutput(
  registry: Map<string, BackgroundProcessHandle>,
  archived: Map<string, PersistedBackgroundProcessRecord>,
  pathsProvider: BackgroundCommandPathsProvider | undefined,
  processId: string,
  limits: CommandOutputLimits,
  options: { consume?: boolean } = { consume: true }
): CommandRunResult {
  const handle = registry.get(processId);
  if (handle) {
    flushPersist(handle, pathsProvider);
    const result = resultFromHandle(handle, limits);
    if (handle.status !== 'running' && options.consume !== false) {
      registry.delete(processId);
      deletePersistedBackgroundRecord(pathsProvider, archived, processId);
    }
    return result;
  }

  const record = archived.get(processId);
  if (record) {
    const result = resultFromPersistedRecord(record, limits);
    if (record.status !== 'running' && options.consume !== false) deletePersistedBackgroundRecord(pathsProvider, archived, processId);
    return result;
  }

  return { command: '', exitCode: 1, killed: false, status: 'not_found', processId, running: false, stdout: '', stderr: `未找到后台进程：${processId}（可能已结束并被清理）。` };
}
function killBackgroundProcess(
  registry: Map<string, BackgroundProcessHandle>,
  archived: Map<string, PersistedBackgroundProcessRecord>,
  pathsProvider: BackgroundCommandPathsProvider | undefined,
  processId: string
): CommandRunResult {
  const handle = registry.get(processId);
  if (!handle) {
    const record = archived.get(processId);
    if (record) {
      const result = resultFromPersistedRecord({ ...record, status: 'killed', killed: true, exitCode: record.exitCode ?? 1, updatedAt: Date.now(), exitedAt: Date.now() }, DEFAULT_OUTPUT_LIMITS);
      deletePersistedBackgroundRecord(pathsProvider, archived, processId);
      return result;
    }
    return { command: '', exitCode: 1, killed: false, status: 'not_found', processId, running: false, stdout: '', stderr: `未找到后台进程：${processId}（可能已结束并被清理）。` };
  }
  if (handle.status === 'running') {
    handle.status = 'killed';
    handle.exitedAt = Date.now();
    handle.suppressPersist = true;
    killProcessTree(handle.child.pid, handle.kind);
  }
  flushPersist(handle, pathsProvider);
  deletePersistedBackgroundRecord(pathsProvider, archived, processId);
  return resultFromHandle(handle, DEFAULT_OUTPUT_LIMITS);
}
function disposeRegistry(registry: Map<string, BackgroundProcessHandle>, pathsProvider: BackgroundCommandPathsProvider | undefined): void {
  for (const handle of registry.values()) {
    if (handle.status === 'running') {
      markAbnormalTermination(handle, '扩展关闭或重启后无法恢复后台进程，已标记为异常终止。');
      killProcessTree(handle.child.pid, handle.kind);
    }
    flushPersist(handle, pathsProvider);
  }
  registry.clear();
}
function detectCommandProfile(): CommandProfile {
  if (process.platform === 'win32') {
    return {
      kind: 'powershell',
      toolName: 'shell',
      commandPrefix: PS_UTF8_PREFIX,
      description: `在项目目录下通过 PowerShell 执行非交互命令(mode=execute)。返回 stdout、stderr 和退出码。
超时行为：命令在 timeout(必填,毫秒)内未结束时不会被终止，而是转入后台继续运行并返回 processId(timeout=0 表示直接转后台)；随后可用 mode=output 查看当前全部输出、mode=kill 终止。后台进程结束后日志会一直保留，直到你用 mode=output 读取一次(读取即清理)。
安全拦截：内置仅拦截格式化磁盘/文件系统和直接删除根目录；其他命令可通过工具策略中的命令黑名单控制。
命令规范：多条命令用分号 ; 分隔；路径含空格时用双引号；长输出建议加 | Select-Object -First N。
编码规范：工具默认把 PowerShell 输入/输出设为 UTF-8；如读取非 UTF-8 文件，请在命令中显式指定 -Encoding。`
    };
  }

  return {
    kind: 'bash',
    toolName: 'bash',
    executable: process.env.SHELL || '/bin/bash',
    description: `在项目目录下通过 Bash/Shell 执行非交互命令(mode=execute)。返回 stdout、stderr 和退出码。
超时行为：命令在 timeout(必填,毫秒)内未结束时不会被终止，而是转入后台继续运行并返回 processId(timeout=0 表示直接转后台)；随后可用 mode=output 查看当前全部输出、mode=kill 终止。后台进程结束后日志会一直保留，直到你用 mode=output 读取一次(读取即清理)。
安全拦截：内置仅拦截格式化磁盘/文件系统和直接删除根目录；其他命令可通过工具策略中的命令黑名单控制。
命令规范：多条命令建议用 && 连接；路径含空格时用双引号；长输出建议加 | head -n N。`
  };
}

let cachedPowerShell: string | undefined;
function resolvePowerShell(): string {
  if (cachedPowerShell) return cachedPowerShell;
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 3000, windowsHide: true });
    cachedPowerShell = 'pwsh.exe';
  } catch {
    cachedPowerShell = 'powershell.exe';
  }
  return cachedPowerShell;
}

async function runCommand(profile: CommandProfile, registry: Map<string, BackgroundProcessHandle>, archived: Map<string, PersistedBackgroundProcessRecord>, pathsProvider: BackgroundCommandPathsProvider | undefined, args: CommandRunArgs, observer: CommandRunObserver | undefined, options: WorkEnvironmentCapabilityOptions = {}, limits: CommandOutputLimits = DEFAULT_OUTPUT_LIMITS): Promise<CommandRunResult> {
  const command = (args.command ?? '').trim();
  if (!command) return failedResult('', 'Missing required argument: command');

  const remoteEnvironment = isRemoteServerCommandEnvironment(options.workEnvironment) ? options.workEnvironment : undefined;
  if (!remoteEnvironment) {
    const environmentError = validateCommandWorkEnvironment(options);
    if (environmentError) return failedResult(command, environmentError);
  }

  const safetyKind: ShellKind = remoteEnvironment ? 'bash' : profile.kind;
  const safety = classifyCommand(safetyKind, command);
  if (safety === 'deny') {
    return failedResult(command, `安全拒绝: ${getDenyReason(safetyKind, command) ?? '命令被安全策略拒绝'}\n该操作命中内置格式化/根目录删除保护，无法绕过。`);
  }

  if (remoteEnvironment) {
    // TODO: 远程 SSH 分支暂不支持超时转后台，超时仍会终止；后台管理仅本地命令可用。
    const raw = await runRemoteServerCommand(remoteEnvironment, args, observer);
    return annotateResult('bash', { ...raw, status: raw.killed ? 'killed' : 'completed' });
  }

  const cwd = resolveWorkDir(args.cwd, options);
  const timeout = resolveTimeout(args.timeout);
  const raw = await executeCommand(profile, registry, archived, pathsProvider, command, cwd, timeout, limits, observer);
  return annotateResult(profile.kind, raw);
}

function executeCommand(profile: CommandProfile, registry: Map<string, BackgroundProcessHandle>, archived: Map<string, PersistedBackgroundProcessRecord>, pathsProvider: BackgroundCommandPathsProvider | undefined, command: string, cwd: string, timeout: number, limits: CommandOutputLimits, observer?: CommandRunObserver): Promise<CommandRunResult> {
  const wrappedCommand = `${profile.commandPrefix ?? ''}${command}`;
  return new Promise((resolve) => {
    const stdout = new AppendBuffer(BACKGROUND_MAX_CHARS);
    const stderr = new AppendBuffer(BACKGROUND_MAX_CHARS);
    let streamEvents = createStreamEventEmitter(observer);
    const startedAt = Date.now();
    let settled = false;
    let backgrounded = false;
    let handle: BackgroundProcessHandle | undefined;

    const child = spawn(commandExecutable(profile), commandArgs(profile, wrappedCommand), {
      cwd,
      windowsHide: true,
      detached: profile.kind === 'bash' && process.platform !== 'win32',
      env: nonInteractiveEnv(profile.kind)
    });

    // 转入后台继续运行（不再 kill），立即以 running 状态 resolve 前台 promise。
    // 触发时机：timeout>0 到点触发；timeout===0 生成子进程后立即触发。
    const moveToBackground = (): void => {
      if (settled) return;
      backgrounded = true;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      streamEvents.flush();
      streamEvents = createStreamEventEmitter(undefined); // 停止向已终态的 toolCall 推流，仅写 buffer
      const processId = generateProcessId(registry, archived);
      handle = { processId, child, kind: profile.kind, command, cwd, stdout, stderr, status: 'running', exitCode: null, startedAt };
      registry.set(processId, handle);
      persistHandle(handle, pathsProvider);
      // 返回截至转后台一刻的输出（全量快照；完整日志随进程继续累积，后续 output 可再全量读取）。
      const out = stdout.snapshot();
      const err = stderr.snapshot();
      resolve({
        command,
        exitCode: 0,
        killed: false,
        status: 'running',
        processId,
        running: true,
        stdout: truncateOutput(out.text, limits),
        stderr: truncateOutput(err.text, limits)
      });
    };

    const timeoutTimer = timeout > 0 ? setTimeout(moveToBackground, timeout) : undefined;
    timeoutTimer?.unref?.();

    const settleForeground = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      streamEvents.flush();
      const out = stdout.snapshot();
      const err = stderr.snapshot();
      resolve({
        command,
        exitCode,
        killed: false,
        status: 'completed',
        stdout: truncateOutput(out.text, limits),
        stderr: truncateOutput(err.text, limits)
      });
    };

    const finalizeBackground = (exitCode: number): void => {
      if (!handle) return;
      handle.exitCode = exitCode;
      handle.exitedAt = Date.now();
      if (handle.status !== 'killed') handle.status = 'exited';
      persistHandle(handle, pathsProvider);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout.append(chunk);
      if (handle) schedulePersist(handle, pathsProvider);
      streamEvents.push('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr.append(chunk);
      if (handle) schedulePersist(handle, pathsProvider);
      streamEvents.push('stderr', chunk);
    });
    child.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      stderr.append(message);
      if (handle) schedulePersist(handle, pathsProvider);
      streamEvents.push('stderr', message);
      if (backgrounded) finalizeBackground(1);
      else settleForeground(1);
    });
    child.once('close', (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      if (backgrounded) {
        streamEvents.flush(); // 让退出前的残余输出进 buffer，供最后一次 output 读取
        finalizeBackground(exitCode);
      } else {
        settleForeground(exitCode);
      }
    });
    child.stdin?.end();

    // timeout=0：不做前台等待，子进程一启动即转入后台执行。
    if (timeout === 0) moveToBackground();
  });
}

function commandArgs(profile: CommandProfile, wrappedCommand: string): string[] {
  return profile.kind === 'powershell'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrappedCommand]
    : ['-lc', wrappedCommand];
}

function commandExecutable(profile: CommandProfile): string {
  return profile.executable ?? resolvePowerShell();
}

/**
 * 追加式输出缓冲：保留当前日志正文，随时可全量读取（不依赖任何读取游标/历史）。
 * 总量超过 maxChars 时环形丢弃最旧字符，并累计 droppedChars 供提示。
 */
function resultFromHandle(handle: BackgroundProcessHandle, limits: CommandOutputLimits): CommandRunResult {
  const out = handle.stdout.snapshot();
  const err = handle.stderr.snapshot();
  const running = handle.status === 'running';
  const dropped = out.dropped + err.dropped;
  return {
    command: handle.command,
    exitCode: handle.exitCode ?? 0,
    killed: handle.status === 'killed',
    status: running ? 'running' : handle.status,
    processId: handle.processId,
    running,
    stdout: truncateOutput(out.text, limits),
    stderr: truncateOutput(err.text, limits),
    ...(dropped > 0 ? { droppedChars: dropped } : {})
  };
}

function resultFromPersistedRecord(record: PersistedBackgroundProcessRecord, limits: CommandOutputLimits): CommandRunResult {
  const running = record.status === 'running';
  const dropped = record.droppedStdoutChars + record.droppedStderrChars;
  return {
    command: record.command,
    exitCode: record.exitCode ?? 0,
    killed: record.killed || record.status === 'killed',
    status: running ? 'running' : record.status,
    processId: record.processId,
    running,
    stdout: truncateOutput(record.stdout, limits),
    stderr: truncateOutput(record.stderr, limits),
    ...(dropped > 0 ? { droppedChars: dropped } : {})
  };
}

function schedulePersist(handle: BackgroundProcessHandle, pathsProvider: BackgroundCommandPathsProvider | undefined): void {
  if (handle.suppressPersist || handle.persistTimer) return;
  handle.persistTimer = setTimeout(() => {
    handle.persistTimer = undefined;
    persistHandle(handle, pathsProvider);
  }, BACKGROUND_PERSIST_DEBOUNCE_MS);
  handle.persistTimer.unref?.();
}

function flushPersist(handle: BackgroundProcessHandle, pathsProvider: BackgroundCommandPathsProvider | undefined): void {
  if (handle.persistTimer) {
    clearTimeout(handle.persistTimer);
    handle.persistTimer = undefined;
  }
  persistHandle(handle, pathsProvider);
}

function persistHandle(handle: BackgroundProcessHandle, pathsProvider: BackgroundCommandPathsProvider | undefined): void {
  if (handle.suppressPersist) return;
  savePersistedBackgroundRecord(pathsProvider, persistedRecordFromHandle(handle));
}

function persistedRecordFromHandle(handle: BackgroundProcessHandle): PersistedBackgroundProcessRecord {
  const out = handle.stdout.snapshot();
  const err = handle.stderr.snapshot();
  return {
    version: BACKGROUND_COMMAND_STORAGE_VERSION,
    processId: handle.processId,
    kind: handle.kind,
    command: handle.command,
    cwd: handle.cwd,
    stdout: out.text,
    stderr: err.text,
    droppedStdoutChars: out.dropped,
    droppedStderrChars: err.dropped,
    status: handle.status,
    exitCode: handle.exitCode,
    killed: handle.status === 'killed',
    startedAt: handle.startedAt,
    updatedAt: Date.now(),
    ...(handle.exitedAt !== undefined ? { exitedAt: handle.exitedAt } : {})
  };
}

function markAbnormalTermination(handle: BackgroundProcessHandle, reason: string): void {
  handle.status = 'exited';
  handle.exitCode = handle.exitCode ?? 1;
  handle.exitedAt = Date.now();
  handle.stderr.append(`${handle.stderr.snapshot().text ? '\n' : ''}[LimCode] ${reason}`);
}

function loadPersistedBackgroundRecords(pathsProvider: BackgroundCommandPathsProvider | undefined, archived: Map<string, PersistedBackgroundProcessRecord>): void {
  const locations = backgroundCommandStorageLocations(pathsProvider);
  if (!locations) return;
  const index = readBackgroundCommandIndex(locations.indexPath);
  let changed = false;
  for (const entry of index.records) {
    const filePath = path.join(locations.recordsRootPath, entry.file);
    const record = readJsonFile<PersistedBackgroundProcessRecord>(filePath);
    if (!isPersistedBackgroundProcessRecord(record)) {
      changed = true;
      continue;
    }
    let next = record;
    if (record.status === 'running') {
      next = {
        ...record,
        status: 'exited',
        exitCode: 1,
        killed: false,
        stderr: appendLine(record.stderr, '[LimCode] 扩展重启后无法恢复后台进程，已标记为异常终止。'),
        updatedAt: Date.now(),
        exitedAt: Date.now()
      };
      writeJsonFile(filePath, next);
      changed = true;
    }
    entry.status = next.status;
    entry.updatedAt = next.updatedAt;
    archived.set(next.processId, next);
  }
  if (changed) writeBackgroundCommandIndex(locations.indexPath, { version: BACKGROUND_COMMAND_STORAGE_VERSION, records: index.records.filter((entry) => archived.has(entry.processId)) });
}

function savePersistedBackgroundRecord(pathsProvider: BackgroundCommandPathsProvider | undefined, record: PersistedBackgroundProcessRecord): void {
  const locations = backgroundCommandStorageLocations(pathsProvider);
  if (!locations) return;
  try {
    fs.mkdirSync(locations.recordsRootPath, { recursive: true });
    const index = readBackgroundCommandIndex(locations.indexPath);
    let entry = index.records.find((candidate) => candidate.processId === record.processId);
    if (!entry) {
      entry = {
        processId: record.processId,
        file: `${formatTimestamp(record.startedAt)}-${safeFileName(record.processId)}.json`,
        status: record.status,
        updatedAt: record.updatedAt
      };
      index.records.push(entry);
    } else {
      entry.status = record.status;
      entry.updatedAt = record.updatedAt;
    }
    writeJsonFile(path.join(locations.recordsRootPath, entry.file), record);
    writeBackgroundCommandIndex(locations.indexPath, index);
  } catch (error) {
    console.warn('[LimCode] Failed to persist background command output:', error);
  }
}

function deletePersistedBackgroundRecord(pathsProvider: BackgroundCommandPathsProvider | undefined, archived: Map<string, PersistedBackgroundProcessRecord>, processId: string): void {
  archived.delete(processId);
  const locations = backgroundCommandStorageLocations(pathsProvider);
  if (!locations) return;
  try {
    const index = readBackgroundCommandIndex(locations.indexPath);
    const entry = index.records.find((candidate) => candidate.processId === processId);
    if (entry) {
      try { fs.unlinkSync(path.join(locations.recordsRootPath, entry.file)); } catch { /* ignore missing record */ }
    }
    writeBackgroundCommandIndex(locations.indexPath, { version: BACKGROUND_COMMAND_STORAGE_VERSION, records: index.records.filter((candidate) => candidate.processId !== processId) });
  } catch (error) {
    console.warn('[LimCode] Failed to delete background command output:', error);
  }
}

function backgroundCommandStorageLocations(pathsProvider: BackgroundCommandPathsProvider | undefined): { rootPath: string; indexPath: string; recordsRootPath: string } | undefined {
  const paths = pathsProvider?.();
  if (!paths) return undefined;
  return {
    rootPath: paths.backgroundCommandsRootPath,
    indexPath: paths.backgroundCommandsIndexPath,
    recordsRootPath: path.join(paths.backgroundCommandsRootPath, BACKGROUND_COMMAND_RECORDS_DIR)
  };
}

function readBackgroundCommandIndex(indexPath: string): BackgroundCommandIndexFile {
  const value = readJsonFile<BackgroundCommandIndexFile>(indexPath);
  if (!value || !Array.isArray(value.records)) return { version: BACKGROUND_COMMAND_STORAGE_VERSION, records: [] };
  return { version: BACKGROUND_COMMAND_STORAGE_VERSION, records: value.records.filter(isBackgroundCommandIndexRecord) };
}

function writeBackgroundCommandIndex(indexPath: string, index: BackgroundCommandIndexFile): void {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  writeJsonFile(indexPath, { version: BACKGROUND_COMMAND_STORAGE_VERSION, records: index.records });
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isBackgroundCommandIndexRecord(value: unknown): value is BackgroundCommandIndexRecord {
  const record = asRecord(value);
  return !!record && typeof record.processId === 'string' && typeof record.file === 'string' && isBackgroundStatus(record.status) && typeof record.updatedAt === 'number';
}

function isPersistedBackgroundProcessRecord(value: unknown): value is PersistedBackgroundProcessRecord {
  const record = asRecord(value);
  return !!record
    && record.version === BACKGROUND_COMMAND_STORAGE_VERSION
    && typeof record.processId === 'string'
    && (record.kind === 'powershell' || record.kind === 'bash')
    && typeof record.command === 'string'
    && typeof record.cwd === 'string'
    && typeof record.stdout === 'string'
    && typeof record.stderr === 'string'
    && typeof record.droppedStdoutChars === 'number'
    && typeof record.droppedStderrChars === 'number'
    && isBackgroundStatus(record.status)
    && (typeof record.exitCode === 'number' || record.exitCode === null)
    && typeof record.killed === 'boolean'
    && typeof record.startedAt === 'number'
    && typeof record.updatedAt === 'number';
}

function isBackgroundStatus(value: unknown): value is 'running' | 'exited' | 'killed' {
  return value === 'running' || value === 'exited' || value === 'killed';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function appendLine(text: string, line: string): string {
  return text ? `${text}\n${line}` : line;
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  const pad = (input: number, length = 2): string => String(input).padStart(length, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'background-command';
}
class AppendBuffer {
  private buffer = '';
  private droppedChars = 0;

  public constructor(private readonly maxChars: number) {}

  public append(value: string): void {
    if (!value) return;
    this.buffer += value;
    if (this.buffer.length > this.maxChars) {
      const overflow = this.buffer.length - this.maxChars;
      this.buffer = this.buffer.slice(overflow);
      this.droppedChars += overflow;
    }
  }

  /** 读取当前保留的全部日志正文。与调用次数无关，每次都返回当前已累积的完整内容。 */
  public snapshot(): { text: string; dropped: number } {
    return { text: this.buffer, dropped: this.droppedChars };
  }
}

/**
 * 按上限截断给模型的输出：先保留末尾 maxOutputLines 行，再按 maxOutputChars 保留末尾字符。
 * （命令的结论/错误/进度通常在末尾，故取尾部。）
 */
function truncateOutput(text: string, limits: CommandOutputLimits): string {
  if (!text) return text;
  let out = text;
  if (limits.maxOutputLines > 0) {
    const lines = out.split('\n');
    if (lines.length > limits.maxOutputLines) {
      const omitted = lines.length - limits.maxOutputLines;
      out = `... (共 ${lines.length} 行，已省略前 ${omitted} 行) ...\n${lines.slice(-limits.maxOutputLines).join('\n')}`;
    }
  }
  if (limits.maxOutputChars > 0 && out.length > limits.maxOutputChars) {
    out = `... (已按 ${limits.maxOutputChars} 字符上限截断) ...\n${out.slice(-limits.maxOutputChars)}`;
  }
  return out;
}

type StreamOutputKind = 'stdout' | 'stderr';

function createStreamEventEmitter(observer?: CommandRunObserver): { push(kind: StreamOutputKind, delta: string): void; flush(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingChars = 0;
  const pending: Array<{ kind: StreamOutputKind; delta: string }> = [];

  const clearTimer = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const flush = (): void => {
    clearTimer();
    if (pending.length === 0) return;
    const events = pending.splice(0, pending.length);
    pendingChars = 0;
    for (const event of events) emitStreamDelta(observer, event.kind, event.delta);
  };

  const schedule = (): void => {
    if (timer || !observer?.onEvent) return;
    timer = setTimeout(flush, STREAM_EVENT_FLUSH_INTERVAL_MS);
    timer.unref?.();
  };

  return {
    push(kind, delta) {
      if (!observer?.onEvent || !delta) return;
      const last = pending[pending.length - 1];
      if (last?.kind === kind) last.delta += delta;
      else pending.push({ kind, delta });
      pendingChars += delta.length;
      if (pendingChars >= STREAM_EVENT_FLUSH_CHARS) flush();
      else schedule();
    },
    flush
  };
}

function emitStreamDelta(observer: CommandRunObserver | undefined, kind: StreamOutputKind, delta: string): void {
  for (let offset = 0; offset < delta.length; offset += MAX_STREAM_EVENT_DELTA_CHARS) {
    const chunk = delta.slice(offset, offset + MAX_STREAM_EVENT_DELTA_CHARS);
    try {
      observer?.onEvent?.({ kind, delta: chunk });
    } catch (error) {
      console.warn('[LimCode] Command stream observer failed:', error);
    }
  }
}

function resolveTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_TIMEOUT_MS;
  return value;
}

function resolveWorkDir(cwd: string | undefined, options: WorkEnvironmentCapabilityOptions): string {
  const root = workEnvironmentRootPath(options) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  if (!cwd?.trim()) return root;
  if (path.isAbsolute(cwd)) return cwd;
  return path.resolve(root, cwd);
}

function workEnvironmentRootPath(options: WorkEnvironmentCapabilityOptions): string | undefined {
  const workEnvironment = options.workEnvironment;
  if (workEnvironment && workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalCommand) && workEnvironment.available !== false) {
    const rootPath = workEnvironment.rootPath?.trim();
    if (rootPath) return rootPath;
  }
  return options.accessibleWorkEnvironments
    ?.find((environment) => environment.available !== false && isLocalFolderWorkEnvironment(environment) && workEnvironmentSupportsCapability(environment, WORK_ENVIRONMENT_CAPABILITY.LocalCommand) && environment.rootPath?.trim())
    ?.rootPath?.trim();
}

function validateCommandWorkEnvironment(options: WorkEnvironmentCapabilityOptions): string | undefined {
  const workEnvironment = options.workEnvironment;
  if (!workEnvironment) return undefined;
  if (!workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalCommand)) return `当前工作环境暂不支持本地命令执行：${workEnvironmentDisplayName(workEnvironment)} (${workEnvironment.kind})`;
  if (workEnvironment.available === false) return `当前工作环境不可用：${workEnvironmentDisplayName(workEnvironment)}`;
  if (!workEnvironment.rootPath?.trim()) return `当前工作环境缺少可执行根目录：${workEnvironmentDisplayName(workEnvironment)}`;
  return undefined;
}

function nonInteractiveEnv(kind: ShellKind): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: process.env.CI ?? '1',
    NO_COLOR: process.env.NO_COLOR ?? '1',
    PYTHONIOENCODING: 'utf-8',
    ...(kind === 'bash' ? { LANG: process.env.LANG || 'en_US.UTF-8' } : {})
  };
}

function killProcessTree(pid: number | undefined, kind: ShellKind): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
      return;
    }
    if (kind === 'bash') {
      try { process.kill(-pid, 'SIGTERM'); }
      catch { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } }
      const timer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); }
        catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
      }, 500);
      timer.unref?.();
    }
  } catch {
    // process already exited
  }
}

function annotateResult(kind: ShellKind, result: CommandRunResult): CommandRunResult {
  let stderr = result.stderr;
  const append = (note: string): void => {
    stderr = stderr ? `${stderr}\n${note}` : note;
  };

  if (result.status === 'running' && result.processId) {
    append(`(命令已超时，转入后台继续运行；processId=${result.processId}。用 mode="output" + 该 processId 获取新增输出，或 mode="kill" 终止。)`);
  }

  if (result.exitCode === 1 && !stderr) {
    const cmd = result.command.trim();
    if (kind === 'powershell') {
      if (/^(select-string|sls|findstr|grep|rg)\b/i.test(cmd) || /\|\s*(select-string|sls|findstr|grep|rg)\b/i.test(cmd)) append('(退出码 1 表示无匹配结果，不是错误)');
      if (/^(fc|compare-object|diff)\b/i.test(cmd)) append('(退出码 1 表示文件有差异，不是错误)');
    } else {
      if (/^(grep|egrep|fgrep|rg|ag|ack)\b/i.test(cmd) || /\|\s*(grep|egrep|fgrep|rg|ag|ack)\b/i.test(cmd)) append('(退出码 1 表示无匹配结果，不是错误)');
      if (/^(diff|colordiff|cmp)\b/i.test(cmd)) append('(退出码 1 表示文件有差异，不是错误)');
    }
  }

  return { ...result, stderr };
}

function failedResult(command: string, stderr: string): CommandRunResult {
  return { command, exitCode: 1, killed: false, stdout: '', stderr };
}


const POWERSHELL_HARD_GUARDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^(?:&\s*)?format(?:\.com)?(?:\s+|$).*\b[a-zA-Z]:/i, reason: '禁止格式化磁盘' },
  { pattern: /^(?:&\s*)?Format-Volume(?:\s|$)/i, reason: '禁止格式化文件系统/卷' },
  { pattern: /^(?:&\s*)?(?:Remove-Item|rm|del|erase|rmdir|rd)\b(?=.*(?:-(?:Recurse|r)\b|-[a-z]*r[a-z]*\b|\/s\b))(?=.*(?:-(?:Force|f)\b|-[a-z]*f[a-z]*\b|\/q\b)).*(?:^|\s)(?:--\s+)?["']?(?:[a-zA-Z]:[\\\/]|[\\\/])(?:\*|\.{1,2})?["']?(?=\s|$)/i, reason: '禁止递归强制删除根路径' }
];

const BASH_HARD_GUARDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^(?:(?:sudo(?:\s+-\S+)*|command|builtin|nohup)\s+|env(?:\s+\S+=\S+|\s+-\S+)*\s+)*mkfs(?:\.[a-z0-9_+-]+)?(?:\s|$)/i, reason: '禁止格式化文件系统' },
  { pattern: /^(?:(?:sudo(?:\s+-\S+)*|command|builtin|nohup)\s+|env(?:\s+\S+=\S+|\s+-\S+)*\s+)*rm\b(?=.*\s-[^\s]*r)(?=.*\s-[^\s]*f).*(?:^|\s)(?:--\s+)?["']?\/(?:\*|\.{1,2})?["']?(?=\s|$)/i, reason: '禁止递归强制删除根目录' }
];

const COMMON_SAFE: Record<string, CommandSafetyConfig> = {
  git: { safeSubcommands: ['status', 'log', 'diff', 'show', 'branch', 'tag', 'remote', 'config', 'rev-parse', 'ls-files', 'grep'] },
  npm: { safeSubcommands: ['list', 'ls', 'view', 'info', 'show', 'outdated', 'audit', 'config list', 'config get', 'why', 'explain'] },
  pnpm: { safeSubcommands: ['list', 'ls', 'why', 'config list', 'outdated', 'audit'] },
  yarn: { safeSubcommands: ['list', 'info', 'why', 'config list', 'versions'] },
  node: { safeSubcommands: ['--version', '-v'] },
  python: { safeSubcommands: ['--version', '-V'] },
  python3: { safeSubcommands: ['--version', '-V'] },
  pip: { safeSubcommands: ['list', 'show', 'freeze', 'check'] },
  pip3: { safeSubcommands: ['list', 'show', 'freeze', 'check'] },
  docker: { safeSubcommands: ['ps', 'images', 'info', 'version', 'inspect', 'logs', 'stats', 'top'] },
  rg: { safe: true },
  grep: { safe: true },
  jq: { safe: true }
};

const POWERSHELL_SAFE: Record<string, CommandSafetyConfig> = {
  ...COMMON_SAFE,
  dir: { safe: true },
  type: { safe: true },
  more: { safe: true },
  findstr: { safe: true },
  where: { safe: true },
  echo: { safe: true },
  pwd: { safe: true },
  cd: { safe: true },
  ls: { safe: true },
  cat: { safe: true },
  'get-childitem': { safe: true },
  'get-content': { safe: true },
  'get-item': { safe: true },
  'test-path': { safe: true },
  'resolve-path': { safe: true },
  'select-string': { safe: true },
  'select-object': { safe: true },
  'sort-object': { safe: true },
  'where-object': { safe: true },
  'get-process': { safe: true },
  'get-service': { safe: true },
  'get-command': { safe: true },
  'get-location': { safe: true },
  'compare-object': { safe: true },
  fc: { safe: true },
  ipconfig: { isDangerous: (args) => args.some((arg) => /^\/(release|renew|flushdns|registerdns)/i.test(arg)) },
  ping: { safe: true }
};

const BASH_SAFE: Record<string, CommandSafetyConfig> = {
  ...COMMON_SAFE,
  ls: { safe: true },
  cat: { safe: true },
  head: { safe: true },
  tail: { safe: true },
  wc: { safe: true },
  stat: { safe: true },
  file: { safe: true },
  pwd: { safe: true },
  cd: { safe: true },
  echo: { safe: true },
  printf: { safe: true },
  find: { isDangerous: (args) => args.some((arg) => /^(-exec|-execdir|-delete|-ok|-okdir)$/.test(arg)) },
  sed: { isDangerous: (args) => args.some((arg) => /^-[a-zA-Z]*i/.test(arg)) },
  awk: { safe: true },
  sort: { safe: true },
  uniq: { safe: true },
  cut: { safe: true },
  tr: { safe: true },
  diff: { safe: true },
  cmp: { safe: true },
  uname: { safe: true },
  whoami: { safe: true },
  id: { safe: true },
  ps: { safe: true },
  df: { safe: true },
  du: { safe: true },
  env: { safe: true },
  printenv: { safe: true },
  which: { safe: true },
  date: { safe: true },
  sleep: { safe: true },
  ping: { isDangerous: (args) => !args.some((arg) => arg === '-c') },
  curl: { isDangerous: (args) => args.some((arg) => /^(-X|--request|-d|--data|--data-raw|--data-binary|-F|--form|--upload-file|-T|--delete)$/.test(arg)) },
  wget: { isDangerous: () => true }
};

function classifyCommand(kind: ShellKind, command: string): StaticClassification {
  const trimmed = command.trim();
  if (!trimmed) return 'deny';
  if (getHardGuardReason(kind, trimmed)) return 'deny';

  const statements = splitStatements(trimmed);
  let allAllow = true;
  for (const stmt of statements) {
    const result = classifySingleStatement(kind, stmt);
    if (result === 'deny') return 'deny';
    if (result === 'unknown') allAllow = false;
  }
  return allAllow ? 'allow' : 'unknown';
}

function classifySingleStatement(kind: ShellKind, stmt: string): StaticClassification {
  const cleaned = kind === 'bash'
    ? stmt.replace(/\s+[12]?>\s*\/dev\/null\b/g, '').replace(/\s+2>&1\b/g, '').replace(/\s+<\s*\/dev\/null\b/g, '')
    : stmt;
  if (/(?:^|[^\-])(?:>>?|2>>?)\s*[^&]/.test(cleaned)) return 'unknown';

  const tokens = stmt.trim().split(/\s+/);
  const firstToken = tokens[0]?.toLowerCase().replace(/\.exe$/, '');
  if (!firstToken) return 'unknown';
  const config = (kind === 'powershell' ? POWERSHELL_SAFE : BASH_SAFE)[firstToken];
  if (!config) return 'unknown';
  if (config.safe) return 'allow';

  const restArgs = tokens.slice(1);
  if (config.isDangerous) return config.isDangerous(restArgs) ? 'unknown' : 'allow';
  if (config.safeSubcommands) {
    const rest = stmt.slice(tokens[0].length).trim().toLowerCase();
    for (const sub of config.safeSubcommands) {
      if (rest.startsWith(sub.toLowerCase())) return 'allow';
    }
    return 'unknown';
  }
  return 'unknown';
}

function splitStatements(command: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;

  const pushCurrent = (): void => {
    const text = current.trim();
    if (text) result.push(text);
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== 'single') {
      current += char;
      escaped = true;
      continue;
    }

    if (char === '`' && quote !== 'single') {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"')) quote = undefined;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char === "'" ? 'single' : 'double';
      current += char;
      continue;
    }

    if (char === ';' || char === '|' || char === '&' || char === '\n' || char === '\r') {
      pushCurrent();
      if ((char === '|' || char === '&') && command[index + 1] === char) index += 1;
      if (char === '\r' && command[index + 1] === '\n') index += 1;
      continue;
    }

    current += char;
  }

  pushCurrent();
  return result;
}

function getDenyReason(kind: ShellKind, command: string): string | null {
  return getHardGuardReason(kind, command);
}

function getHardGuardReason(kind: ShellKind, command: string): string | null {
  const hardGuards = kind === 'powershell' ? POWERSHELL_HARD_GUARDS : BASH_HARD_GUARDS;
  for (const statement of splitStatements(command.trim())) {
    for (const { pattern, reason } of hardGuards) if (pattern.test(statement)) return reason;
  }
  return null;
}
