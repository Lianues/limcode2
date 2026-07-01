import type { ChildProcess } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandCapability, CommandOutputLimits, CommandRunArgs, CommandRunObserver, CommandRunResult, WorkEnvironmentCapabilityOptions } from './types';
import {
  WORK_ENVIRONMENT_CAPABILITY,
  workEnvironmentDisplayName,
  workEnvironmentSupportsCapability
} from '../../shared/workEnvironmentCatalog';
import { isRemoteServerCommandEnvironment, runRemoteServerCommand } from './workEnvironmentProvider';

const DEFAULT_TIMEOUT_MS = 30_000;
/** 后台进程完整日志 buffer 的上限（远大于给模型的软上限，避免过早丢弃可能被 output 读取的历史）。 */
const BACKGROUND_MAX_CHARS = 200_000;
/** 兜底的输出上限（调用方未显式传入 limits 时使用）。 */
const DEFAULT_OUTPUT_LIMITS: CommandOutputLimits = { maxOutputLines: 100, maxOutputChars: 10_000 };
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
}

export function createCommandCapability(): CommandCapability {
  const profile = detectCommandProfile();
  const registry = new Map<string, BackgroundProcessHandle>();
  return {
    toolName: profile.toolName,
    description: profile.description,
    run(args, observer, options, limits) {
      return runCommand(profile, registry, args, observer, options, limits ?? DEFAULT_OUTPUT_LIMITS);
    },
    readOutput(processId, limits) {
      return readBackgroundOutput(registry, processId, limits ?? DEFAULT_OUTPUT_LIMITS);
    },
    kill(processId) {
      return killBackgroundProcess(registry, processId);
    },
    dispose() {
      disposeRegistry(registry);
    }
  };
}

function generateProcessId(registry: Map<string, BackgroundProcessHandle>): string {
  let id = '';
  do {
    id = `bg_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  } while (registry.has(id));
  return id;
}

function readBackgroundOutput(registry: Map<string, BackgroundProcessHandle>, processId: string, limits: CommandOutputLimits): CommandRunResult {
  const handle = registry.get(processId);
  if (!handle) {
    return { command: '', exitCode: 1, killed: false, status: 'not_found', processId, running: false, stdout: '', stderr: `未找到后台进程：${processId}（可能已结束并被清理）。` };
  }
  const out = handle.stdout.snapshot();
  const err = handle.stderr.snapshot();
  const running = handle.status === 'running';
  const dropped = out.dropped + err.dropped;
  // 进程仍在运行 → 保留 handle 供继续轮询；已结束 → 本次读取即为最终结果，读完即删除。
  if (!running) registry.delete(processId);
  return {
    command: handle.command,
    exitCode: handle.exitCode ?? 0,
    killed: handle.status === 'killed',
    status: running ? 'running' : handle.status,
    processId,
    running,
    stdout: truncateOutput(out.text, limits),
    stderr: truncateOutput(err.text, limits),
    ...(dropped > 0 ? { droppedChars: dropped } : {})
  };
}

function killBackgroundProcess(registry: Map<string, BackgroundProcessHandle>, processId: string): CommandRunResult {
  const handle = registry.get(processId);
  if (!handle) {
    return { command: '', exitCode: 1, killed: false, status: 'not_found', processId, running: false, stdout: '', stderr: `未找到后台进程：${processId}（可能已结束并被清理）。` };
  }
  if (handle.status === 'running') {
    handle.status = 'killed';
    handle.exitedAt = Date.now();
    killProcessTree(handle.child.pid, handle.kind);
  }
  // kill 只终止进程；日志持久保留，直到被 output 读取或扩展退出才清理（本次返回当前全量日志作即时反馈）。
  const out = handle.stdout.snapshot();
  const err = handle.stderr.snapshot();
  return {
    command: handle.command,
    exitCode: handle.exitCode ?? 0,
    killed: true,
    status: 'killed',
    processId,
    running: false,
    stdout: truncateOutput(out.text, DEFAULT_OUTPUT_LIMITS),
    stderr: truncateOutput(err.text, DEFAULT_OUTPUT_LIMITS)
  };
}

function disposeRegistry(registry: Map<string, BackgroundProcessHandle>): void {
  for (const handle of registry.values()) {
    if (handle.status === 'running') {
      handle.status = 'killed';
      killProcessTree(handle.child.pid, handle.kind);
    }
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
安全拦截：① 代码内置危险命令黑名单(如格式化磁盘/关机/rm -rf 根目录，不可绕过)；② 用户在工具策略里配置的命令黑名单。
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
安全拦截：① 代码内置危险命令黑名单(如 rm -rf /、mkfs、shutdown 等，不可绕过)；② 用户在工具策略里配置的命令黑名单。
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

async function runCommand(profile: CommandProfile, registry: Map<string, BackgroundProcessHandle>, args: CommandRunArgs, observer: CommandRunObserver | undefined, options: WorkEnvironmentCapabilityOptions = {}, limits: CommandOutputLimits = DEFAULT_OUTPUT_LIMITS): Promise<CommandRunResult> {
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
    return failedResult(command, `安全拒绝: ${getDenyReason(safetyKind, command) ?? '命令被安全策略拒绝'}\n该操作在黑名单中，无法绕过。`);
  }

  if (remoteEnvironment) {
    // TODO: 远程 SSH 分支暂不支持超时转后台，超时仍会终止；后台管理仅本地命令可用。
    const raw = await runRemoteServerCommand(remoteEnvironment, args, observer);
    return annotateResult('bash', { ...raw, status: raw.killed ? 'killed' : 'completed' });
  }

  const cwd = resolveWorkDir(args.cwd, options);
  const timeout = resolveTimeout(args.timeout);
  const raw = await executeCommand(profile, registry, command, cwd, timeout, limits, observer);
  return annotateResult(profile.kind, raw);
}

function executeCommand(profile: CommandProfile, registry: Map<string, BackgroundProcessHandle>, command: string, cwd: string, timeout: number, limits: CommandOutputLimits, observer?: CommandRunObserver): Promise<CommandRunResult> {
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
      const processId = generateProcessId(registry);
      handle = { processId, child, kind: profile.kind, command, cwd, stdout, stderr, status: 'running', exitCode: null, startedAt };
      registry.set(processId, handle);
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
      // 进程结束后日志持久保留在 registry 中，直到被 output 读取或扩展退出才清理。
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout.append(chunk);
      streamEvents.push('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr.append(chunk);
      streamEvents.push('stderr', chunk);
    });
    child.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      stderr.append(message);
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
  if (!workEnvironment || !workEnvironmentSupportsCapability(workEnvironment, WORK_ENVIRONMENT_CAPABILITY.LocalCommand) || workEnvironment.available === false) return undefined;
  return workEnvironment.rootPath?.trim() || undefined;
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


const POWERSHELL_DENY: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bformat\b.*\b[a-zA-Z]:/i, reason: '禁止格式化磁盘' },
  { pattern: /\b(shutdown|restart-computer|stop-computer)\b/i, reason: '禁止系统关机/重启' },
  { pattern: /\bInvoke-Expression\b|\biex\b/i, reason: '禁止动态代码执行' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/i, reason: '禁止 curl | bash 远程代码执行' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh\b/i, reason: '禁止 wget | bash 远程代码执行' },
  { pattern: /Invoke-WebRequest\b.*\|.*Invoke-Expression\b/i, reason: '禁止 iwr | iex 远程代码执行' },
  { pattern: /Start-Process\b.*-Verb\s+RunAs/i, reason: '禁止 UAC 提权' },
  { pattern: /\bRemove-Item\b.*-Recurse.*-Force.*[\\\/](\s|$)/i, reason: '禁止递归强制删除根路径' }
];

const BASH_DENY: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?\/(\s|$)/, reason: '禁止删除根目录' },
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?~\/?(\s|$)/, reason: '禁止删除用户主目录' },
  { pattern: /\bdd\b.*\bof=\/dev\/[sh]d/i, reason: '禁止直接写入磁盘设备' },
  { pattern: /\bmkfs\b/i, reason: '禁止格式化文件系统' },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: '禁止系统关机/重启' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/i, reason: '禁止 curl | bash 远程代码执行' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh\b/i, reason: '禁止 wget | bash 远程代码执行' },
  { pattern: /\beval\b/, reason: '禁止 eval 动态代码执行' },
  { pattern: /\bsudo\b/, reason: '禁止 sudo 提权' },
  { pattern: /:\(\)\s*\{[^}]*:\|:/, reason: '禁止 fork 炸弹' }
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
  const deny = kind === 'powershell' ? POWERSHELL_DENY : BASH_DENY;
  for (const { pattern } of deny) if (pattern.test(trimmed)) return 'deny';

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
  return command.split(/\s*(?:;|&&|\|\||\||\r?\n)\s*/).map((item) => item.trim()).filter(Boolean);
}

function getDenyReason(kind: ShellKind, command: string): string | null {
  const deny = kind === 'powershell' ? POWERSHELL_DENY : BASH_DENY;
  for (const { pattern, reason } of deny) if (pattern.test(command.trim())) return reason;
  return null;
}
