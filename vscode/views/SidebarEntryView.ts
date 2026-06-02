import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import type { BackendApplication, SidebarConversationHistoryEntry } from '../../backend/application/BackendApplication';

const SIDEBAR_ENTRY_VIEW_ID = 'limcode-entry-view';
const OPEN_CONVERSATION_MESSAGE = 'openConversation';
const NEW_CONVERSATION_MESSAGE = 'newConversation';
const OPEN_GLOBAL_SETTINGS_MESSAGE = 'openGlobalSettings';
const REFRESH_HISTORY_MESSAGE = 'refreshConversationHistory';
const HISTORY_UPDATE_MESSAGE = 'conversationHistory.update';
const SIDEBAR_READY_MESSAGE = 'sidebar.ready';
const RENAME_CONVERSATION_MESSAGE = 'renameConversation';
const DELETE_CONVERSATION_MESSAGE = 'deleteConversation';
const ABORT_CONVERSATION_MESSAGE = 'abortConversation';

interface SidebarWebviewMessage {
  type?: string;
  conversationId?: string;
  title?: string;
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
  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backendApp: BackendApplication
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'assets')]
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
        const conversationId = this.backendApp.createConversation();
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { conversationId });
        this.postConversationHistory(webviewView.webview);
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

      if (message.type === SIDEBAR_READY_MESSAGE || message.type === REFRESH_HISTORY_MESSAGE) {
        this.postConversationHistoryWhenReady(webviewView.webview);
      }
    });

    webviewView.webview.html = this.getHtml(webviewView.webview);
  }

  private postConversationHistoryWhenReady(webview: vscode.Webview): void {
    void this.backendApp
      .waitUntilHydrated()
      .then(() => this.postConversationHistory(webview))
      .catch((error) => console.warn('[LimCode] Failed to read sidebar conversation history.', error));
  }

  private renameConversationFromSidebar(webview: vscode.Webview, conversationId: string): void {
    void this.backendApp
      .waitUntilHydrated()
      .then(async () => {
        const current = this.backendApp.getConversationHistoryEntries().find((entry) => entry.id === conversationId);
        const nextTitle = await vscode.window.showInputBox({
          title: '重命名对话标题',
          prompt: '输入新的对话标题。',
          value: current?.title ?? '',
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
        this.postConversationHistory(webview);
      })
      .catch((error) => console.warn('[LimCode] Failed to rename sidebar conversation.', error));
  }

  private deleteConversationFromSidebar(webview: vscode.Webview, conversationId: string): void {
    void this.backendApp
      .waitUntilHydrated()
      .then(async () => {
        const current = this.backendApp.getConversationHistoryEntries().find((entry) => entry.id === conversationId);
        const confirm = await vscode.window.showWarningMessage(
          `删除对话「${current?.title ?? conversationId}」？`,
          { modal: true, detail: '该操作会删除此对话以及关联消息、工具记录和运行记录，无法撤销。' },
          '删除'
        );
        if (confirm !== '删除') return;
        const deleted = this.backendApp.deleteConversation(conversationId);
        if (!deleted) {
          void vscode.window.showWarningMessage('未找到要删除的对话。');
          return;
        }
        this.postConversationHistory(webview);
      })
      .catch((error) => console.warn('[LimCode] Failed to delete sidebar conversation.', error));
  }

  private abortConversationFromSidebar(webview: vscode.Webview, conversationId: string): void {
    void this.backendApp
      .waitUntilHydrated()
      .then(async () => {
        const current = this.backendApp.getConversationHistoryEntries().find((entry) => entry.id === conversationId);
        const confirm = await vscode.window.showWarningMessage(
          `终止对话「${current?.title ?? conversationId}」的后台任务？`,
          { modal: false, detail: '仅终止当前后台运行任务，不删除对话记录。' },
          '终止'
        );
        if (confirm !== '终止') return;
        const aborted = this.backendApp.abortConversation(conversationId);
        if (!aborted) return;
        this.postConversationHistory(webview);
      })
      .catch((error) => console.warn('[LimCode] Failed to abort sidebar conversation.', error));
  }

  private postConversationHistory(webview: vscode.Webview): void {
    void webview.postMessage({
      type: HISTORY_UPDATE_MESSAGE,
      entries: this.backendApp.getConversationHistoryEntries()
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'assets', 'icons', 'panel-entry.svg')
    );
    const initialEntries = serializeForInlineScript(this.backendApp.getConversationHistoryEntries());

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LimCode AI</title>
  <style>
    :root {
      --radius-sm: 4px;
      --radius-md: 6px;
      --sidebar-gap: 10px;
      --surface-subtle: color-mix(in srgb, var(--vscode-sideBar-background) 94%, var(--vscode-foreground) 6%);
      --surface-muted: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-foreground) 12%);
      --line: var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: 12px;
      line-height: 1.45;
    }

    button {
      font: inherit;
    }

    .shell {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .topbar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 10px 8px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 96%, var(--vscode-foreground) 4%);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .brand-mark {
      width: 24px;
      height: 24px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--line);
      background: var(--surface-subtle);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .brand-mark img {
      width: 15px;
      height: 15px;
      opacity: 0.92;
    }

    .brand-text {
      min-width: 0;
    }

    .brand-title {
      font-size: 12px;
      font-weight: 650;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .brand-subtitle {
      margin-top: 1px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .icon-button,
    .back-button,
    .secondary-button,
    .primary-button {
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      color: var(--vscode-foreground);
      background: transparent;
      cursor: pointer;
      outline: none;
      transition: background 0.16s ease, border-color 0.16s ease, transform 0.16s ease, color 0.16s ease;
    }

    .icon-button:hover,
    .back-button:hover,
    .secondary-button:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .icon-button:active,
    .back-button:active,
    .secondary-button:active,
    .primary-button:active {
      transform: translateY(1px);
    }

    .icon-button:focus-visible,
    .back-button:focus-visible,
    .secondary-button:focus-visible,
    .primary-button:focus-visible,
    .history-action-button:focus-visible,
    .history-item:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .icon-button {
      width: 28px;
      height: 28px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .icon-button.is-active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    .view {
      display: none;
      flex: 1 1 auto;
      min-height: 0;
      animation: slide-up 0.22s ease;
    }

    body[data-view='history'] .history-view,
    body[data-view='settings'] .settings-view {
      display: flex;
      flex-direction: column;
    }

    .section-head {
      flex: 0 0 auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      border-bottom: 1px solid var(--line);
    }

    .section-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .section-title {
      font-size: 11px;
      line-height: 1.2;
      font-weight: 650;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }

    .section-count {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      white-space: nowrap;
    }

    .toolbar {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
    }

    .primary-button {
      min-width: 0;
      min-height: 30px;
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
      font-weight: 600;
    }

    .primary-button:hover {
      background: var(--vscode-button-hoverBackground);
      border-color: var(--vscode-button-hoverBackground);
    }

    .secondary-button {
      min-height: 30px;
      padding: 0 9px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: var(--vscode-foreground);
      background: transparent;
    }

    .history-list {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 6px 0;
    }

    .history-item {
      position: relative;
      width: 100%;
      margin: 0;
      padding: 9px 10px 9px 12px;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      display: grid;
      grid-template-columns: 26px minmax(0, 1fr) auto;
      gap: 9px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
      cursor: pointer;
      outline: none;
      transition: background 0.16s ease, transform 0.16s ease;
    }


    .history-item::before {
      content: '';
      position: absolute;
      left: 0;
      top: 9px;
      bottom: 9px;
      width: 2px;
      background: transparent;
      transition: background 0.16s ease;
    }

    .history-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .history-item:hover::before {
      background: var(--vscode-focusBorder);
    }

    .history-avatar {
      width: 26px;
      height: 26px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--line);
      background: var(--surface-subtle);
      color: var(--vscode-descriptionForeground);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 1px;
    }

    .history-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .history-title-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .history-title {
      min-width: 0;
      flex: 1;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: var(--vscode-descriptionForeground);
      opacity: 0.6;
    }

    .status-streaming {
      background: var(--vscode-testing-iconQueued);
      opacity: 1;
      animation: pulse-glow 1.4s infinite ease-in-out;
    }

    .status-running {
      background: var(--vscode-testing-iconQueued);
      opacity: 1;
      animation: pulse-glow 1.4s infinite ease-in-out;
    }

    .status-complete {
      background: var(--vscode-testing-iconPassed);
      opacity: 1;
    }

    .status-error {
      background: var(--vscode-testing-iconFailed);
      opacity: 1;
    }

    .history-preview {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .history-meta {
      margin-top: 1px;
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .history-meta span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .run-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      max-width: 100%;
      padding: 1px 5px;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 86%, var(--vscode-foreground) 14%);
      font-size: 10px;
      line-height: 1.3;
    }

    .run-badge-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--vscode-testing-iconQueued);
      animation: pulse-glow 1.4s infinite ease-in-out;
      flex: 0 0 auto;
    }

    .history-actions {
      align-self: start;
      display: flex;
      align-items: center;
      gap: 3px;
      opacity: 0.55;
      transition: opacity 0.16s ease;
    }

    .history-item:hover .history-actions,
    .history-item:focus-within .history-actions {
      opacity: 1;
    }

    .history-action-button {
      width: 23px;
      height: 23px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      cursor: pointer;
      outline: none;
      transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
    }

    .history-action-button:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
    }

    .history-action-button:active {
      transform: translateY(1px);
    }

    .history-action-button.danger:hover {
      color: var(--vscode-errorForeground);
      background: var(--vscode-inputValidation-errorBackground, var(--vscode-list-hoverBackground));
      border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-focusBorder));
    }

    .empty-state {
      margin: 22px 12px;
      padding: 18px 14px;
      border: 1px dashed var(--line);
      border-radius: var(--radius-md);
      background: transparent;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state-title {
      margin: 0 0 6px;
      color: var(--vscode-foreground);
      font-weight: 650;
    }

    .empty-state-desc {
      margin: 0;
      font-size: 11px;
    }

    .settings-view {
      background: var(--vscode-sideBar-background);
    }

    .settings-head {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px;
      border-bottom: 1px solid var(--line);
    }

    .back-button {
      width: 28px;
      height: 28px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }

    .settings-heading {
      min-width: 0;
    }

    .settings-title {
      font-size: 13px;
      font-weight: 650;
      line-height: 1.25;
    }

    .settings-desc {
      margin-top: 1px;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .settings-content {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .settings-card {
      border: 1px solid var(--line);
      border-radius: var(--radius-md);
      background: var(--surface-subtle);
      padding: 11px;
    }

    .settings-card-title {
      display: flex;
      align-items: center;
      gap: 7px;
      margin: 0 0 5px;
      font-size: 12px;
      font-weight: 650;
    }

    .settings-card-desc {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .settings-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 7px;
      margin-top: 9px;
    }

    .setting-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 7px 0;
      border-top: 1px solid var(--line);
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .setting-row strong {
      color: var(--vscode-foreground);
      font-size: 11px;
      font-weight: 600;
    }

    .settings-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 2px;
    }

    @keyframes slide-up {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes pulse-glow {
      0% {
        transform: scale(0.86);
        opacity: 0.55;
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-testing-iconQueued) 38%, transparent);
      }
      50% {
        transform: scale(1.16);
        opacity: 1;
        box-shadow: 0 0 5px 1px var(--vscode-testing-iconQueued);
      }
      100% {
        transform: scale(0.86);
        opacity: 0.55;
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-testing-iconQueued) 38%, transparent);
      }
    }
  </style>
</head>
<body data-view="history">
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <img src="${iconUri}" alt="">
        </div>
        <div class="brand-text">
          <div class="brand-title">LimCode</div>
          <div class="brand-subtitle">AI 对话工作区</div>
        </div>
      </div>
      <button id="settingsButton" type="button" class="icon-button" title="全局设置" aria-label="全局设置">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>
    </header>

    <section class="view history-view" aria-label="对话历史">
      <div class="section-head">
        <div class="section-title-row">
          <div class="section-title">对话历史</div>
          <div id="historyCount" class="section-count">0 个对话</div>
        </div>
        <div class="toolbar">
          <button id="newConversationButton" type="button" class="primary-button" title="新建对话">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            新对话
          </button>
          <button id="refreshHistoryButton" type="button" class="secondary-button" title="刷新对话历史" aria-label="刷新对话历史">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
              <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"></path>
            </svg>
          </button>
        </div>
      </div>
      <div id="historyList" class="history-list"></div>
      <div id="emptyState" class="empty-state" hidden>
        <p class="empty-state-title">暂无对话历史</p>
        <p class="empty-state-desc">点击“新对话”创建一个独立会话空间。</p>
      </div>
    </section>

    <section class="view settings-view" aria-label="全局设置">
      <div class="settings-head">
        <button id="backToHistoryButton" type="button" class="back-button" title="返回对话历史" aria-label="返回对话历史">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <div class="settings-heading">
          <div class="settings-title">全局设置</div>
          <div class="settings-desc">模型、密钥、数据目录与默认行为</div>
        </div>
      </div>

      <div class="settings-content">
        <article class="settings-card">
          <h3 class="settings-card-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2v20"></path><path d="M5 9h14"></path><path d="M5 15h14"></path>
            </svg>
            模型与 API
          </h3>
          <p class="settings-card-desc">配置默认 LLM Provider、模型名称、Base URL 和 API Key。</p>
          <div class="settings-grid">
            <div class="setting-row"><span>配置范围</span><strong>全局默认</strong></div>
            <div class="setting-row"><span>优先级</span><strong>可被对话设置覆盖</strong></div>
          </div>
        </article>

        <article class="settings-card">
          <h3 class="settings-card-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7h18"></path><path d="M5 7v12h14V7"></path><path d="M9 11h6"></path>
            </svg>
            数据与存储
          </h3>
          <p class="settings-card-desc">管理 LimCode 数据根目录，保持 Agent、Conversation 与 Link 独立存储。</p>
          <div class="settings-grid">
            <div class="setting-row"><span>存储结构</span><strong>ECS 解耦</strong></div>
            <div class="setting-row"><span>主题适配</span><strong>跟随 VS Code</strong></div>
          </div>
        </article>

        <div class="settings-actions">
          <button id="openFullSettingsButton" type="button" class="primary-button">打开完整设置面板</button>
          <button id="backToHistoryButtonBottom" type="button" class="secondary-button">返回对话历史</button>
        </div>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialEntries = ${initialEntries};
    const HISTORY_REFRESH_INTERVAL_MS = 2500;
    let historyEntries = Array.isArray(initialEntries) ? initialEntries : [];

    const historyList = document.getElementById('historyList');
    const emptyState = document.getElementById('emptyState');
    const historyCount = document.getElementById('historyCount');
    const settingsButton = document.getElementById('settingsButton');

    function setView(view) {
      document.body.dataset.view = view;
      settingsButton.classList.toggle('is-active', view === 'settings');
      settingsButton.setAttribute('aria-pressed', view === 'settings' ? 'true' : 'false');
    }

    function renderHistory() {
      historyList.textContent = '';
      historyCount.textContent = historyEntries.length + (historyEntries.length === 1 ? ' 个对话' : ' 个对话');
      emptyState.hidden = historyEntries.length > 0;

      for (const entry of historyEntries) {
        historyList.appendChild(createHistoryItem(entry));
      }
    }

    function createHistoryItem(entry) {
      const item = document.createElement('div');
      item.className = 'history-item' + (entry.isRunning ? ' is-running' : '');
      item.title = '打开对话：' + (entry.title || entry.id);
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', '打开对话：' + (entry.title || entry.id));
      item.addEventListener('click', () => openConversation(entry.id));
      item.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openConversation(entry.id);
      });

      function openConversation(conversationId) {
        vscode.postMessage({ type: '${OPEN_CONVERSATION_MESSAGE}', conversationId: entry.id });
      }

      const avatar = document.createElement('div');
      avatar.className = 'history-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';

      const main = document.createElement('div');
      main.className = 'history-main';

      const titleRow = document.createElement('div');
      titleRow.className = 'history-title-row';

      const title = document.createElement('div');
      title.className = 'history-title';
      title.textContent = entry.title || entry.id;

      const dot = document.createElement('span');
      dot.className = 'status-dot ' + statusClass(entry);
      dot.title = statusText(entry);

      titleRow.appendChild(title);
      titleRow.appendChild(dot);

      const preview = document.createElement('div');
      preview.className = 'history-preview';
      preview.textContent = entry.preview || '暂无消息，点击继续对话。';

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const metaText = document.createElement('span');
      metaText.textContent = (entry.agentName || '默认 Agent') + ' · ' + (entry.messageCount || 0) + ' 条消息 · ' + formatTime(entry.updatedAt);
      meta.appendChild(metaText);

      if (entry.isRunning) {
        const badge = document.createElement('span');
        badge.className = 'run-badge';
        badge.title = '后台任务：' + (entry.runStatusLabel || '执行中');
        const badgeDot = document.createElement('span');
        badgeDot.className = 'run-badge-dot';
        badgeDot.setAttribute('aria-hidden', 'true');
        const badgeText = document.createElement('span');
        badgeText.textContent = entry.runStatusLabel || '后台执行中';
        badge.appendChild(badgeDot);
        badge.appendChild(badgeText);
        meta.appendChild(badge);
      }

      const actions = document.createElement('div');
      actions.className = 'history-actions';
      actions.addEventListener('click', (event) => event.stopPropagation());
      actions.addEventListener('keydown', (event) => event.stopPropagation());

      const renameButton = document.createElement('button');
      renameButton.type = 'button';
      renameButton.className = 'history-action-button';
      renameButton.title = '重命名对话标题';
      renameButton.setAttribute('aria-label', '重命名对话标题');
      renameButton.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
      renameButton.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: '${RENAME_CONVERSATION_MESSAGE}', conversationId: entry.id });
      });

      const abortButton = document.createElement('button');
      abortButton.type = 'button';
      abortButton.className = 'history-action-button';
      abortButton.title = '终止后台任务';
      abortButton.setAttribute('aria-label', '终止后台任务');
      abortButton.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"></rect></svg>';
      abortButton.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: '${ABORT_CONVERSATION_MESSAGE}', conversationId: entry.id });
      });

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'history-action-button danger';
      deleteButton.title = '删除对话';
      deleteButton.setAttribute('aria-label', '删除对话');
      deleteButton.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      deleteButton.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: '${DELETE_CONVERSATION_MESSAGE}', conversationId: entry.id });
      });

      if (entry.isRunning) actions.appendChild(abortButton);
      actions.appendChild(renameButton);
      actions.appendChild(deleteButton);

      main.appendChild(titleRow);
      main.appendChild(preview);
      main.appendChild(meta);
      item.appendChild(avatar);
      item.appendChild(main);
      item.appendChild(actions);
      return item;
    }

    function statusClass(entry) {
      if (entry.isRunning) return 'status-running';
      if (entry.status === 'streaming') return 'status-streaming';
      if (entry.status === 'complete') return 'status-complete';
      if (entry.status === 'error') return 'status-error';
      return 'status-empty';
    }

    function statusText(entry) {
      if (entry.isRunning) return '后台任务：' + (entry.runStatusLabel || '执行中');
      if (entry.status === 'streaming') return '正在响应';
      if (entry.status === 'complete') return '已完成';
      if (entry.status === 'error') return '出现错误';
      return '暂无消息';
    }

    function formatTime(value) {
      if (!value) return '未开始';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '未开始';
      const now = new Date();
      const sameDay = date.toDateString() === now.toDateString();
      if (sameDay) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    }

    settingsButton.addEventListener('click', () => setView('settings'));
    document.getElementById('backToHistoryButton').addEventListener('click', () => setView('history'));
    document.getElementById('backToHistoryButtonBottom').addEventListener('click', () => setView('history'));
    document.getElementById('openFullSettingsButton').addEventListener('click', () => {
      vscode.postMessage({ type: '${OPEN_GLOBAL_SETTINGS_MESSAGE}' });
    });
    document.getElementById('newConversationButton').addEventListener('click', () => {
      vscode.postMessage({ type: '${NEW_CONVERSATION_MESSAGE}' });
    });
    document.getElementById('refreshHistoryButton').addEventListener('click', () => {
      vscode.postMessage({ type: '${REFRESH_HISTORY_MESSAGE}' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message && message.type === '${HISTORY_UPDATE_MESSAGE}' && Array.isArray(message.entries)) {
        historyEntries = message.entries;
        renderHistory();
      }
    });

    renderHistory();
    vscode.postMessage({ type: '${SIDEBAR_READY_MESSAGE}' });
    window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      vscode.postMessage({ type: '${REFRESH_HISTORY_MESSAGE}' });
    }, HISTORY_REFRESH_INTERVAL_MS);
  </script>
</body>
</html>`;
  }
}

function serializeForInlineScript(entries: SidebarConversationHistoryEntry[]): string {
  return JSON.stringify(entries).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}
