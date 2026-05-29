import * as vscode from 'vscode';
import { getWebviewHtml } from '../webview/getWebviewHtml';
import type { BackendApplication } from '../../backend/application/BackendApplication';

export class MainPanel {
  public static currentPanel: MainPanel | undefined;
  public static readonly viewType = 'limcode.mainPanel';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly backendApp: BackendApplication;
  private readonly disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, backendApp: BackendApplication): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (MainPanel.currentPanel) {
      MainPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      MainPanel.viewType,
      'LimCode',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
        portMapping: [{ webviewPort: 31773, extensionHostPort: 31773 }]
      }
    );

    MainPanel.currentPanel = new MainPanel(panel, extensionUri, backendApp);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, backendApp: BackendApplication) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.backendApp = backendApp;

    this.backendApp.attachWebview(panel.webview);
    this.panel.webview.html = getWebviewHtml(this.panel.webview, this.extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message) => {
        this.backendApp.handleWebviewMessage(message);
      },
      null,
      this.disposables
    );
  }

  public dispose(): void {
    MainPanel.currentPanel = undefined;
    this.backendApp.detachWebview();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }
}
