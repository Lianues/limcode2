import * as vscode from 'vscode';
import type { BackendApplication } from '../../backend/application/BackendApplication';
import { GLOBAL_SETTINGS_SECTIONS, type GlobalSettingsSection } from '../../shared/protocol';
import { LIMCODE_GLOBAL_STATUS_FILE } from '../../backend/capabilities/vscodeStorage/globalStatus';

/**
 * 全局设置文件监听白名单。
 *
 * 必须逐个列举，绝不能写成 `settings/*.json`：settings 目录里绝大多数文件是
 * 每会话一份的 `conversation-*-llm.json`，多 agent 任务会在短时间内批量写入，
 * 用通配会把刷新事件刷爆。
 */
export const GLOBAL_STATUS_WATCH_PATTERN = LIMCODE_GLOBAL_STATUS_FILE;

export const GLOBAL_SETTINGS_WATCH_PATTERNS = [
  'settings/{llm,llm-compression,appearance,attachments,checkpoint-maintenance,run-history}.json',
  'settings/llm-provider-configs/**/*.json',
  'settings/llm-compression-configs/**/*.json',
  'settings/mcp-servers/**/*.json'
] as const;

const REFRESH_DEBOUNCE_MS = 180;

/** 顶层设置文件名 → section 映射，用于把文件事件收敛到需要刷新的 section。 */
const FILE_NAME_SECTIONS: Record<string, GlobalSettingsSection> = {
  'llm.json': 'llm',
  'llm-compression.json': 'llmCompression',
  'appearance.json': 'appearance',
  'attachments.json': 'attachments',
  'checkpoint-maintenance.json': 'checkpointMaintenance',
  'run-history.json': 'runHistory'
};

/** 子目录 → section 映射。 */
const DIRECTORY_SECTIONS: Record<string, GlobalSettingsSection> = {
  'llm-provider-configs': 'llmProviderConfigs',
  'llm-compression-configs': 'llmCompressionConfigs',
  'mcp-servers': 'mcpServers'
};

export function registerGlobalSettingsWatcher(context: vscode.ExtensionContext, backendApp: BackendApplication): void {
  const watcher = new GlobalSettingsWatcher(backendApp, context.globalStorageUri);
  context.subscriptions.push(watcher);
  // data root 被用户改掉后，watcher 必须重建到新的根目录。
  context.subscriptions.push(backendApp.onDidChangeStorageRoot(() => watcher.ensureWatcher()));
  watcher.ensureWatcher();
}

/**
 * 监听 data root 下的全局设置文件，其他窗口写入后把最新值重新下发给本窗口。
 *
 * 刷新动作就是 `postSnapshot`（重新读盘再广播），是幂等纯读操作，
 * 所以不需要自写抑制：自己保存触发自己，只是把刚写的值再下发一次。
 */
class GlobalSettingsWatcher implements vscode.Disposable {
  private watchers: vscode.FileSystemWatcher[] = [];
  private watchedRoot: string | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly dirtySections = new Set<GlobalSettingsSection>();

  public constructor(
    private readonly backendApp: BackendApplication,
    private readonly canonicalStatusRoot: vscode.Uri
  ) {}

  public ensureWatcher(): void {
    const root = this.backendApp.getStorageRootUri();
    const rootKey = root.toString();
    if (this.watchers.length > 0 && this.watchedRoot === rootKey) return;

    this.disposeWatchers();
    this.watchedRoot = rootKey;

    for (const pattern of GLOBAL_SETTINGS_WATCH_PATTERNS) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, pattern));
      const schedule = (uri: vscode.Uri) => this.scheduleRefresh(uri);
      watcher.onDidCreate(schedule);
      watcher.onDidChange(schedule);
      watcher.onDidDelete(schedule);
      this.watchers.push(watcher);
    }

    // common/proxy 的 canonical authority 位于 Extension globalStorageUri，而不是 active
    // data root/settings。若不单独监听，多 Extension Host 同时存活时 proxy 外部修改永远不刷新。
    const statusWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.canonicalStatusRoot, GLOBAL_STATUS_WATCH_PATTERN)
    );
    const scheduleCommon = () => this.scheduleSection('common');
    statusWatcher.onDidCreate(scheduleCommon);
    statusWatcher.onDidChange(scheduleCommon);
    statusWatcher.onDidDelete(scheduleCommon);
    this.watchers.push(statusWatcher);
  }

  public dispose(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.disposeWatchers();
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }

  private scheduleRefresh(uri: vscode.Uri): void {
    const section = sectionFromSettingsUri(uri);
    if (!section) return;
    this.scheduleSection(section);
  }

  private scheduleSection(section: GlobalSettingsSection): void {
    this.dirtySections.add(section);

    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const sections = [...this.dirtySections];
      this.dirtySections.clear();
      for (const dirtySection of sections) {
        void this.backendApp.postGlobalSettingsSnapshot(dirtySection)
          .catch((error) => console.warn(`[LimCode] Failed to refresh global settings after external change: ${dirtySection}`, error));
      }
    }, REFRESH_DEBOUNCE_MS);
  }
}

export function sectionFromSettingsUri(uri: vscode.Uri): GlobalSettingsSection | undefined {
  const segments = uri.path.split('/').filter(Boolean);
  const settingsIndex = segments.lastIndexOf('settings');
  if (settingsIndex < 0) return undefined;

  const rest = segments.slice(settingsIndex + 1);
  if (rest.length === 0) return undefined;
  if (rest.length === 1) return assertSection(FILE_NAME_SECTIONS[rest[0]]);
  return assertSection(DIRECTORY_SECTIONS[rest[0]]);
}

function assertSection(section: GlobalSettingsSection | undefined): GlobalSettingsSection | undefined {
  return section && GLOBAL_SETTINGS_SECTIONS.includes(section) ? section : undefined;
}
