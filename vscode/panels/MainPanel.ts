import * as vscode from 'vscode';
import { createMessageId, type BridgeClientId, type WebviewToExtensionMessage } from '../../shared/protocol';
import { getWebviewHtml } from '../webview/getWebviewHtml';
import type { BackendApplication } from '../../backend/application/BackendApplication';

export interface MainPanelOptions {
  conversationId?: string;
  reuse?: boolean;
}

export class MainPanel {
  public static readonly viewType = 'limcode.mainPanel';

  private static readonly panels = new Map<string, MainPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly backendApp: BackendApplication;
  private readonly panelId: string;
  private readonly clientId: BridgeClientId;
  private readonly disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    backendApp: BackendApplication,
    options: MainPanelOptions = {}
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (options.reuse) {
      const existing = [...MainPanel.panels.values()].find((candidate) => candidate.matchesConversation(options.conversationId));
      if (existing) {
        existing.panel.reveal(column);
        return;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      MainPanel.viewType,
      options.conversationId ? `LimCode: ${options.conversationId}` : 'LimCode',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
        portMapping: [{ webviewPort: 31773, extensionHostPort: 31773 }]
      }
    );

    const instance = new MainPanel(panel, extensionUri, backendApp, options);
    MainPanel.panels.set(instance.panelId, instance);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    backendApp: BackendApplication,
    options: MainPanelOptions
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.backendApp = backendApp;
    this.panelId = createMessageId();
    this.clientId = this.backendApp.attachWebview(panel.webview, {
      kind: 'mainPanel',
      panelId: this.panelId,
      title: panel.title,
      conversationId: options.conversationId
    });

    this.panel.webview.html = getWebviewHtml(this.panel.webview, this.extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        this.backendApp.handleWebviewMessage(this.clientId, message);
      },
      null,
      this.disposables
    );
  }

  public dispose(): void {
    MainPanel.panels.delete(this.panelId);
    this.backendApp.detachWebview(this.clientId);

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private matchesConversation(conversationId: string | undefined): boolean {
    if (!conversationId) return true;
    return this.panel.title.endsWith(conversationId);
  }
}
