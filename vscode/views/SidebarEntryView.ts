import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import type { BackendApplication } from '../../backend/application/BackendApplication';

const SIDEBAR_ENTRY_VIEW_ID = 'limcode-entry-view';
const OPEN_PANEL_MESSAGE = 'openPanel';

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
    body {
      margin: 0;
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
    }

    .entry {
      display: flex;
      flex-direction: column;
      gap: 12px;
      align-items: stretch;
    }

    .entry-card {
      border: 1px dashed var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      border-radius: 10px;
      padding: 14px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 85%, var(--vscode-foreground) 15%);
      text-align: center;
    }

    .icon {
      width: 56px;
      height: 56px;
      margin-bottom: 10px;
    }

    h2 {
      margin: 0 0 8px;
      font-size: 14px;
      line-height: 1.4;
    }

    p {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.6;
    }

    button {
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
      font: inherit;
      font-size: 13px;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
  </style>
</head>
<body>
  <main class="entry">
    <section class="entry-card">
      <img class="icon" src="${iconUri}" alt="" aria-hidden="true">
      <h2>LimCode AI</h2>
      <p>基础 AI 对话已就绪。历史记录会保存到插件全局数据目录。</p>
    </section>

    <button id="openPanelButton" type="button" title="打开 LimCode AI 对话">
      打开 AI 对话
    </button>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('openPanelButton').addEventListener('click', () => {
      vscode.postMessage({ type: '${OPEN_PANEL_MESSAGE}' });
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
