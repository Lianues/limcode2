import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import { getWebviewHtml } from '../webview/getWebviewHtml';
import type { BackendApplication } from '../../backend/application/BackendApplication';
import type {
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  ProjectFolderCandidateRecord,
  SidebarHistoryScopeKind
} from '../../shared/protocol';

const SIDEBAR_ENTRY_VIEW_ID = 'limcode-entry-view';
const OPEN_CONVERSATION_MESSAGE = 'openConversation';
const NEW_CONVERSATION_MESSAGE = 'newConversation';
const OPEN_GLOBAL_SETTINGS_MESSAGE = 'openGlobalSettings';
const REFRESH_HISTORY_MESSAGE = 'refreshConversationHistory';
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
}

class SidebarEntryViewProvider implements vscode.WebviewViewProvider {
  private lastScopeKind: SidebarHistoryScopeKind = 'currentProject';
  private lastProjectFolderUri: string | undefined;
  private lastCursor: string | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backendApp: BackendApplication
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')
      ]
    };

    webviewView.webview.onDidReceiveMessage((message: SidebarWebviewMessage) => {
      if (message.type === OPEN_CONVERSATION_MESSAGE && message.conversationId) {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, {
          conversationId: message.conversationId,
          reuse: true
        });
        return;
      }

      if (message.type === NEW_CONVERSATION_MESSAGE) {
        const conversationId = this.backendApp.createConversation({ projectFolderUri: message.projectFolderUri });
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { conversationId });
        this.postSidebarStateWhenReady(webviewView.webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
        return;
      }

      if (message.type === OPEN_GLOBAL_SETTINGS_MESSAGE) {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { kind: 'globalSettings', reuse: true });
        return;
      }

      if (message.type === RENAME_CONVERSATION_MESSAGE && message.conversationId) {
        this.renameConversationFromSidebar(webviewView.webview, message.conversationId);
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

      if (message.type === REFRESH_HISTORY_MESSAGE) {
        this.postSidebarStateWhenReady(webviewView.webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
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

  private postSidebarStateWhenReady(webview: vscode.Webview, scopeKind: SidebarHistoryScopeKind = 'currentProject', cursor?: string, limit?: number, projectFolderUri?: string): void {
    void this.backendApp
      .waitUntilHydrated()
      .then(() => this.postSidebarState(webview, scopeKind, cursor, limit, projectFolderUri))
      .catch((error) => console.warn('[LimCode] Failed to read sidebar state.', error));
  }

  private renameConversationFromSidebar(webview: vscode.Webview, conversationId: string): void {
    void this.backendApp
      .waitUntilHydrated()
      .then(async () => {
        const nextTitle = await vscode.window.showInputBox({
          title: '重命名对话标题',
          prompt: '输入新的对话标题。',
          value: '',
          ignoreFocusOut: true,
          validateInput(value) {
            return value.trim() ? undefined : '标题不能为空';
          }
        });
        if (nextTitle === undefined) return;
        const renamed = this.backendApp.renameConversationTitle(conversationId, nextTitle);
        if (!renamed) {
          void vscode.window.showWarningMessage('未找到要重命名的对话。');
          return;
        }
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
      })
      .catch((error) => console.warn('[LimCode] Failed to rename sidebar conversation.', error));
  }

  private deleteConversationFromSidebar(webview: vscode.Webview, conversationId: string): void {
    void this.backendApp
      .waitUntilHydrated()
      .then(async () => {
        const confirm = await vscode.window.showWarningMessage(
          `删除对话「${conversationId}」？`,
          { modal: true, detail: '该操作会删除此对话以及关联消息、工具记录和运行记录，无法撤销。' },
          '删除'
        );
        if (confirm !== '删除') return;
        const deleted = this.backendApp.deleteConversation(conversationId);
        if (!deleted) {
          void vscode.window.showWarningMessage('未找到要删除的对话。');
          return;
        }
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
      })
      .catch((error) => console.warn('[LimCode] Failed to delete sidebar conversation.', error));
  }

  private abortConversationFromSidebar(webview: vscode.Webview, conversationId: string): void {
    void this.backendApp
      .waitUntilHydrated()
      .then(async () => {
        const confirm = await vscode.window.showWarningMessage(
          `终止对话「${conversationId}」的后台任务？`,
          { modal: false, detail: '仅终止当前后台运行任务，不删除对话记录。' },
          '终止'
        );
        if (confirm !== '终止') return;
        const aborted = this.backendApp.abortConversation(conversationId);
        if (!aborted) return;
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
      projectFolders: this.backendApp.getProjectFolderCandidates()
    };
    void webview.postMessage(message);
  }
}
