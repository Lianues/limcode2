import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import type { BackendApplication } from '../../backend/application/BackendApplication';

const SIDEBAR_ENTRY_VIEW_ID = 'limcode-entry-view';
const OPEN_PANEL_MESSAGE = 'openPanel';
const NEW_CONVERSATION_MESSAGE = 'newConversation';
const OPEN_GLOBAL_SETTINGS_MESSAGE = 'openGlobalSettings';

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

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message.type === OPEN_PANEL_MESSAGE) {
        MainPanel.createOrShow(this.extensionUri, this.backendApp);
        return;
      }
      if (message.type === NEW_CONVERSATION_MESSAGE) {
        const conversationId = this.backendApp.createConversation();
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { conversationId });
        return;
      }
      if (message.type === OPEN_GLOBAL_SETTINGS_MESSAGE) {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { kind: 'globalSettings' });
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'assets', 'icons', 'panel-entry.svg')
    );

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LimCode AI</title>
  <style>
    /* 采用 CSS variables 保持对 VS Code 各类主题的完美适配，无硬编码蓝紫 */
    :root {
      --radius-sm: 4px;
      --radius-md: 6px;
    }

    body {
      margin: 0;
      padding: 14px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: 13px;
      line-height: 1.5;
    }

    .entry {
      display: flex;
      flex-direction: column;
      gap: 12px;
      align-items: stretch;
    }

    /* 欢迎卡片区域 */
    .entry-card {
      position: relative;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.15));
      border-radius: var(--radius-md);
      padding: 16px 14px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 95%, var(--vscode-foreground) 5%);
      text-align: center;
      overflow: hidden;
      margin-bottom: 4px;
    }

    /* 顶部细条点缀：使用 VS Code 按钮背景色作为品牌亮点，天然适配主题 */
    .entry-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background-color: var(--vscode-button-background);
      opacity: 0.8;
    }

    .icon-container {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-foreground) 12%);
      margin-bottom: 10px;
    }

    .icon {
      width: 24px;
      height: 24px;
    }

    h2 {
      margin: 0 0 6px;
      font-size: 14px;
      font-weight: 600;
      line-height: 1.4;
      color: var(--vscode-foreground);
    }

    p {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.5;
    }

    /* 动作列表：重构为交互式卡片式按钮 */
    .action-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .action-card {
      width: 100%;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 12px;
      border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      border-radius: var(--radius-md);
      padding: 10px 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      cursor: pointer;
      font: inherit;
      text-align: left;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      outline: none;
      margin: 0;
    }

    /* 悬停微动交互 */
    .action-card:hover {
      background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.08));
      border-color: var(--vscode-focusBorder);
      transform: translateX(3px);
    }

    .action-card:active {
      transform: translateX(1px);
    }

    .action-card:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    /* 按钮左侧图标框 */
    .action-icon {
      flex: 0 0 auto;
      width: 30px;
      height: 30px;
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, var(--vscode-foreground) 10%);
      color: var(--vscode-foreground);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }

    .action-card:hover .action-icon {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .action-details {
      flex: 1;
      min-width: 0;
    }

    .action-title {
      font-weight: 600;
      font-size: 12px;
      color: var(--vscode-foreground);
      margin-bottom: 2px;
    }

    .action-desc {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* 系统状态面板 */
    .status-panel {
      border: 1px dashed var(--vscode-panel-border, rgba(128, 128, 128, 0.15));
      border-radius: var(--radius-md);
      padding: 10px 12px;
      background: transparent;
      margin-top: 6px;
    }

    .status-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .status-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .status-indicator {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--vscode-testing-iconPassedColor, #4caf50);
      font-weight: 500;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      background: var(--vscode-testing-iconPassedColor, #4caf50);
      border-radius: 50%;
      display: inline-block;
      animation: pulse-glow 1.5s infinite ease-in-out;
    }

    @keyframes pulse-glow {
      0% {
        transform: scale(0.85);
        opacity: 0.5;
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-testing-iconPassedColor, #4caf50) 40%, transparent);
      }
      50% {
        transform: scale(1.15);
        opacity: 1;
        box-shadow: 0 0 4px 1px var(--vscode-testing-iconPassedColor, #4caf50);
      }
      100% {
        transform: scale(0.85);
        opacity: 0.5;
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-testing-iconPassedColor, #4caf50) 40%, transparent);
      }
    }

    .status-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    .status-item {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .status-label {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .status-val {
      font-size: 11px;
      font-weight: 500;
    }

    /* 技巧贴士面板 */
    .tips-panel {
      margin-top: 6px;
      padding: 10px 12px;
      border: 1px solid transparent;
    }

    .tips-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .tips-list {
      margin: 0;
      padding-left: 14px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }

    .tips-list li {
      margin-bottom: 4px;
    }
  </style>
</head>
<body>
  <main class="entry">
    <!-- 欢迎栏 -->
    <section class="entry-card">
      <div class="icon-container">
        <img class="icon" src="${iconUri}" alt="" aria-hidden="true">
      </div>
      <h2>LimCode AI</h2>
      <p>基础 AI 引擎已就绪。支持在本地存储中持久化和管理你的全部对话记录。</p>
    </section>

    <!-- 功能卡片列表 -->
    <section class="action-list">
      <!-- 1. 加载默认对话 -->
      <button id="openPanelButton" type="button" class="action-card" title="加载默认 LimCode AI 对话">
        <div class="action-icon">
          <!-- 极简聊天气泡 SVG -->
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <div class="action-details">
          <div class="action-title">加载默认对话</div>
          <div class="action-desc">唤起并查看上次活跃的 AI 会话</div>
        </div>
      </button>

      <!-- 2. 新建对话 -->
      <button id="newConversationButton" type="button" class="action-card" title="新建 LimCode AI 对话">
        <div class="action-icon">
          <!-- 极简加号 SVG -->
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </div>
        <div class="action-details">
          <div class="action-title">新建对话</div>
          <div class="action-desc">创建全新、独立的会话空间</div>
        </div>
      </button>

      <!-- 3. 全局设置 -->
      <button id="openGlobalSettingsButton" type="button" class="action-card" title="打开 LimCode 全局设置">
        <div class="action-icon">
          <!-- 极简齿轮设置 SVG -->
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </div>
        <div class="action-details">
          <div class="action-title">全局设置</div>
          <div class="action-desc">管理 API 密钥和本地存储根目录</div>
        </div>
      </button>
    </section>

    <!-- 系统状态看板 -->
    <section class="status-panel">
      <div class="status-header">
        <span class="status-title">系统状态</span>
        <span class="status-indicator">
          <span class="status-dot"></span>
          连接就绪
        </span>
      </div>
      <div class="status-grid">
        <div class="status-item">
          <span class="status-label">核心引擎</span>
          <span class="status-val">ECS Core</span>
        </div>
        <div class="status-item">
          <span class="status-label">架构模式</span>
          <span class="status-val">完全解耦</span>
        </div>
      </div>
    </section>

    <!-- 快捷小提示 -->
    <section class="tips-panel">
      <div class="tips-title">💡 使用小贴士</div>
      <ul class="tips-list">
        <li>双击对话中的文件框，即可极速应用代码修改差异。</li>
        <li>支持多 Agent 协同运作，在对话设置中可任意切换。</li>
        <li>侧边栏随时随地可以用来建立并维护多个独立沙盒会话。</li>
      </ul>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('openPanelButton').addEventListener('click', () => {
      vscode.postMessage({ type: '${OPEN_PANEL_MESSAGE}' });
    });
    document.getElementById('newConversationButton').addEventListener('click', () => {
      vscode.postMessage({ type: '${NEW_CONVERSATION_MESSAGE}' });
    });
    document.getElementById('openGlobalSettingsButton').addEventListener('click', () => {
      vscode.postMessage({ type: '${OPEN_GLOBAL_SETTINGS_MESSAGE}' });
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}
