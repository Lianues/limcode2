import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import { getWebviewHtml } from '../webview/getWebviewHtml';
import type { BackendApplication } from '../../backend/application/BackendApplication';
import type {
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  OpenConversationPanelRecord,
  ProjectFolderCandidateRecord,
  SidebarHistoryScopeKind
} from '../../shared/protocol';

const SIDEBAR_ENTRY_VIEW_ID = 'limcode-entry-view';
const OPEN_CONVERSATION_MESSAGE = 'openConversation';
const NEW_CONVERSATION_MESSAGE = 'newConversation';
const OPEN_GLOBAL_SETTINGS_MESSAGE = 'openGlobalSettings';
const HISTORY_PAGE_GET_MESSAGE = 'sidebar.historyPage.get';
const SIDEBAR_STATE_MESSAGE = 'sidebar.state';
const SIDEBAR_READY_MESSAGE = 'sidebar.ready';
const RENAME_CONVERSATION_MESSAGE = 'renameConversation';
const DELETE_CONVERSATION_MESSAGE = 'deleteConversation';
const ABORT_CONVERSATION_MESSAGE = 'abortConversation';

interface SidebarWebviewMessage {
  type?: string;
  conversationId?: string;
  title?: string;
  projectFolderUri?: string;
  scopeKind?: SidebarHistoryScopeKind;
  cursor?: string;
  limit?: number;
}

interface SidebarStateMessage {
  type: typeof SIDEBAR_STATE_MESSAGE;
  history: ConversationHistoryPageRecord;
  activeScopeKind: SidebarHistoryScopeKind;
  activeProjectFolderUri?: string;
  currentProjectScope: ConversationHistoryScope;
  projectFolders: ProjectFolderCandidateRecord[];
  openConversations: OpenConversationPanelRecord[];
}

export function registerSidebarEntryView(context: vscode.ExtensionContext, backendApp: BackendApplication): void {
  const provider = new SidebarEntryViewProvider(context.extensionUri, backendApp);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_ENTRY_VIEW_ID, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );
  context.subscriptions.push(MainPanel.onDidChangeConversationPanelState(() => provider.refreshPanelStates()));
  context.subscriptions.push(backendApp.onDidChangeConversationHistory(() => provider.refreshPanelStates()));
}

class SidebarEntryViewProvider implements vscode.WebviewViewProvider {
  private lastScopeKind: SidebarHistoryScopeKind = 'currentProject';
  private lastProjectFolderUri: string | undefined;
  private lastCursor: string | undefined;
  private activeWebview: vscode.Webview | undefined;
  private historyWatcher: vscode.FileSystemWatcher | undefined;
  private historyWatcherRoot: string | undefined;
  private historyRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backendApp: BackendApplication
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.activeWebview = webviewView.webview;
    webviewView.onDidDispose(() => {
      if (this.activeWebview === webviewView.webview) this.activeWebview = undefined;
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')
      ]
    };

    this.ensureConversationHistoryWatcher();

    webviewView.webview.onDidReceiveMessage((message: SidebarWebviewMessage) => {
      if (message.type === OPEN_CONVERSATION_MESSAGE && message.conversationId) {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, {
          conversationId: message.conversationId,
          title: message.title,
          reuse: true
        });
        return;
      }

      if (message.type === NEW_CONVERSATION_MESSAGE) {
        this.createConversationFromSidebar(webviewView.webview, message.projectFolderUri);
        return;
      }

      if (message.type === OPEN_GLOBAL_SETTINGS_MESSAGE) {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { kind: 'globalSettings', reuse: true });
        return;
      }

      if (message.type === RENAME_CONVERSATION_MESSAGE && message.conversationId && typeof message.title === 'string') {
        this.renameConversationFromSidebar(webviewView.webview, message.conversationId, message.title);
        return;
      }

      if (message.type === DELETE_CONVERSATION_MESSAGE && message.conversationId) {
        this.deleteConversationFromSidebar(webviewView.webview, message.conversationId);
        return;
      }

      if (message.type === ABORT_CONVERSATION_MESSAGE && message.conversationId) {
        this.abortConversationFromSidebar(webviewView.webview, message.conversationId);
        return;
      }

      if (message.type === SIDEBAR_READY_MESSAGE) {
        this.postSidebarStateWhenReady(webviewView.webview, 'currentProject');
        return;
      }

      if (message.type === HISTORY_PAGE_GET_MESSAGE) {
        this.postSidebarStateWhenReady(webviewView.webview, message.scopeKind ?? 'currentProject', message.cursor, message.limit, message.projectFolderUri);
      }
    });

    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionUri, {
      htmlFileName: 'sidebar.html',
      devEntry: '/src/sidebar/main.ts',
      title: 'LimCode Sidebar',
      rootId: 'sidebar-app'
    });
  }

  public refreshPanelStates(): void {
    this.scheduleConversationHistoryRefresh();
  }

  private postSidebarStateWhenReady(webview: vscode.Webview, scopeKind: SidebarHistoryScopeKind = 'currentProject', cursor?: string, limit?: number, projectFolderUri?: string): void {
    this.activeWebview = webview;
    this.ensureConversationHistoryWatcher();
    void this.postSidebarState(webview, scopeKind, cursor, limit, projectFolderUri)
      .catch((error) => console.warn('[LimCode] Failed to read sidebar state.', error));
  }

  private ensureConversationHistoryWatcher(): void {
    const root = this.backendApp.getConversationHistoryRootUri();
    const rootKey = root.toString();
    if (this.historyWatcher && this.historyWatcherRoot === rootKey) return;

    this.historyWatcher?.dispose();
    this.historyWatcherRoot = rootKey;
    void Promise.resolve(vscode.workspace.fs.createDirectory(root)).catch((error: unknown) => {
      console.warn('[LimCode] Failed to ensure conversation history watcher root.', error);
    });

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.json'));
    const schedule = () => this.scheduleConversationHistoryRefresh();
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    this.historyWatcher = watcher;
  }

  private scheduleConversationHistoryRefresh(): void {
    if (this.historyRefreshTimer !== undefined) clearTimeout(this.historyRefreshTimer);
    this.historyRefreshTimer = setTimeout(() => {
      this.historyRefreshTimer = undefined;
      const target = this.activeWebview;
      if (!target) return;
      this.postSidebarStateWhenReady(target, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
    }, 180);
  }

  private createConversationFromSidebar(webview: vscode.Webview, projectFolderUri?: string): void {
    void this.backendApp
      .createConversation({ projectFolderUri })
      .then((conversationId) => {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { conversationId });
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
      })
      .catch((error) => console.warn('[LimCode] Failed to create sidebar conversation.', error));
  }

  private renameConversationFromSidebar(webview: vscode.Webview, conversationId: string, title: string): void {
    const nextTitle = title.trim();
    if (!nextTitle) return;

    void this.backendApp
      .waitUntilHydrated()
      .then(() => {
        const renamed = this.backendApp.renameConversationTitle(conversationId, nextTitle);
        if (!renamed) console.warn(`[LimCode] Sidebar rename target not found: ${conversationId}`);
        else MainPanel.refreshConversationTitle(conversationId);
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
      })
      .catch((error) => console.warn('[LimCode] Failed to rename sidebar conversation.', error));
  }

  private deleteConversationFromSidebar(webview: vscode.Webview, conversationId: string): void {
    void this.backendApp
      .waitUntilHydrated()
      .then(() => {
        const deleted = this.backendApp.deleteConversation(conversationId);
        if (!deleted) console.warn(`[LimCode] Sidebar delete target not found: ${conversationId}`);
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
      })
      .catch((error) => console.warn('[LimCode] Failed to delete sidebar conversation.', error));
  }

  private abortConversationFromSidebar(webview: vscode.Webview, conversationId: string): void {
    void this.backendApp
      .waitUntilHydrated()
      .then(() => {
        const aborted = this.backendApp.abortConversation(conversationId);
        if (!aborted) console.warn(`[LimCode] Sidebar abort target not found: ${conversationId}`);
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
      })
      .catch((error) => console.warn('[LimCode] Failed to abort sidebar conversation.', error));
  }

  private async postSidebarState(webview: vscode.Webview, scopeKind: SidebarHistoryScopeKind, cursor?: string, limit?: number, projectFolderUri?: string): Promise<void> {
    this.lastScopeKind = scopeKind;
    this.lastProjectFolderUri = projectFolderUri;
    this.lastCursor = cursor;
    const history = await this.backendApp.getConversationHistoryPage({ scopeKind, projectFolderUri, cursor, limit });
    const activeProjectFolderUri = projectFolderUri
      ?? (history.scope.kind === 'project' ? history.scope.folderUri : undefined);
    const message: SidebarStateMessage = {
      type: SIDEBAR_STATE_MESSAGE,
      history,
      activeScopeKind: scopeKind,
      ...(activeProjectFolderUri ? { activeProjectFolderUri } : {}),
      currentProjectScope: this.backendApp.getCurrentProjectHistoryScope(),
      projectFolders: this.backendApp.getProjectFolderCandidates(),
      openConversations: MainPanel.getOpenConversationPanelStates()
    };
    void webview.postMessage(message);
  }
}
