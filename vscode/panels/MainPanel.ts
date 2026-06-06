import * as vscode from 'vscode';
import {
  BridgeMessageType,
  createMessageId,
  type BridgeClientId,
  type OpenConversationPanelRecord,
  type WebviewClientMeta,
  type WebviewToExtensionMessage
} from '../../shared/protocol';
import { displayConversationTitle, displayConversationTitleFromText } from '../../shared/conversationTitle';
import { getWebviewHtml } from '../webview/getWebviewHtml';
import type { BackendApplication } from '../../backend/application/BackendApplication';

export interface MainPanelOptions {
  conversationId?: string;
  title?: string;
  kind?: 'chat' | 'globalSettings';
  reuse?: boolean;
}

type MainPanelKind = 'chat' | 'globalSettings';

export class MainPanel {
  public static readonly viewType = 'limcode.mainPanel';

  private static readonly panels = new Map<string, MainPanel>();
  private static readonly conversationPanelStateEmitter = new vscode.EventEmitter<void>();
  public static readonly onDidChangeConversationPanelState = MainPanel.conversationPanelStateEmitter.event;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly backendApp: BackendApplication;
  private readonly panelId: string;
  private readonly clientId: BridgeClientId;
  private readonly kind: MainPanelKind;
  private readonly conversationId?: string;
  private readonly disposables: vscode.Disposable[] = [];

  public static registerSerializer(context: vscode.ExtensionContext, backendApp: BackendApplication): void {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(MainPanel.viewType, {
        async deserializeWebviewPanel(webviewPanel, state) {
          const options = optionsFromSerializedState(state, webviewPanel.title);
          MainPanel.revive(webviewPanel, context.extensionUri, backendApp, options);
        }
      })
    );
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    backendApp: BackendApplication,
    options: MainPanelOptions = {}
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (options.reuse) {
      const existing = [...MainPanel.panels.values()].find((candidate) => candidate.matches(options));
      if (existing) {
        existing.refreshTitle(options.title);
        existing.panel.reveal(column);
        MainPanel.notifyConversationPanelStateChanged();
        return;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      MainPanel.viewType,
      panelTitle(options, backendApp),
      column,
      MainPanel.webviewPanelOptions(extensionUri)
    );

    MainPanel.revive(panel, extensionUri, backendApp, options);
  }

  private static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    backendApp: BackendApplication,
    options: MainPanelOptions = {}
  ): void {
    const instance = new MainPanel(panel, extensionUri, backendApp, options);
    MainPanel.panels.set(instance.panelId, instance);
    MainPanel.notifyConversationPanelStateChanged();
  }

  private static webviewPanelOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
      portMapping: [{ webviewPort: 31819, extensionHostPort: 31819 }]
    };
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
    this.kind = panelKind(options);
    this.conversationId = options.conversationId;

    this.refreshTitle(options.title);
    this.panel.webview.options = MainPanel.webviewPanelOptions(this.extensionUri);
    this.clientId = this.backendApp.attachWebview(panel.webview, {
      kind: this.kind === 'globalSettings' ? 'globalSettings' : 'mainPanel',
      panelId: this.panelId,
      title: this.panel.title,
      conversationId: this.conversationId
    });

    this.panel.webview.html = getWebviewHtml(this.panel.webview, this.extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(() => MainPanel.notifyConversationPanelStateChanged(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        this.backendApp.handleWebviewMessage(this.clientId, message);
        this.refreshTitleFromOutgoingMessage(message);
      },
      null,
      this.disposables
    );
  }

  public dispose(): void {
    MainPanel.panels.delete(this.panelId);
    MainPanel.notifyConversationPanelStateChanged();
    this.backendApp.detachWebview(this.clientId);

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private matches(options: MainPanelOptions): boolean {
    const kind = panelKind(options);
    if (kind !== this.kind) return false;
    if (kind === 'globalSettings') return true;
    return (options.conversationId ?? '') === (this.conversationId ?? '');
  }

  private refreshTitle(title?: string): void {
    this.panel.title = panelTitle({ kind: this.kind, conversationId: this.conversationId, title }, this.backendApp);
  }

  private refreshTitleFromOutgoingMessage(message: WebviewToExtensionMessage): void {
    if (message.type !== BridgeMessageType.ChatSend) return;
    const payload = message.payload;
    if (!this.conversationId || !payload || payload.conversationId !== this.conversationId) return;
    if (!isDefaultConversationTitle(this.panel.title)) return;
    this.panel.title = displayConversationTitleFromText(payload.text);
  }

  public static refreshConversationTitle(conversationId: string): void {
    for (const panel of MainPanel.panels.values()) {
      if (panel.conversationId === conversationId) panel.refreshTitle();
    }
  }

  public static getOpenConversationPanelStates(): OpenConversationPanelRecord[] {
    const byConversation = new Map<string, OpenConversationPanelRecord>();
    for (const item of MainPanel.panels.values()) {
      if (item.kind !== 'chat' || !item.conversationId) continue;
      const existing = byConversation.get(item.conversationId);
      byConversation.set(item.conversationId, {
        conversationId: item.conversationId,
        visible: (existing?.visible ?? false) || item.panel.visible,
        active: (existing?.active ?? false) || item.panel.active
      });
    }
    return [...byConversation.values()].sort((left, right) => left.conversationId.localeCompare(right.conversationId));
  }

  private static notifyConversationPanelStateChanged(): void {
    MainPanel.conversationPanelStateEmitter.fire();
  }
}

function panelKind(options: MainPanelOptions): MainPanelKind {
  return options.kind === 'globalSettings' ? 'globalSettings' : 'chat';
}

function panelTitle(options: MainPanelOptions, backendApp: BackendApplication): string {
  if (options.kind === 'globalSettings') return 'LimCode 设置';
  if (!options.conversationId) return 'LimCode';
  return options.title
    ? displayConversationTitle({ id: options.conversationId, title: options.title })
    : backendApp.getConversationDisplayTitle(options.conversationId);
}

function isDefaultConversationTitle(title: string): boolean {
  return title === '新对话' || title === '默认对话' || title === 'LimCode' || title.startsWith('LimCode: ');
}

function optionsFromSerializedState(state: unknown, fallbackTitle: string): MainPanelOptions {
  const record = asRecord(state);
  const meta = record ? metaFromState(record.meta) : undefined;
  const serializedKind = record ? stringValue(record.kind) : undefined;
  const isGlobalSettings =
    serializedKind === 'globalSettings' ||
    meta?.kind === 'globalSettings' ||
    fallbackTitle === 'LimCode 设置';

  if (isGlobalSettings) {
    return { kind: 'globalSettings', reuse: true };
  }

  const conversationId =
    (record ? stringValue(record.conversationId) : undefined) ??
    meta?.conversationId ??
    conversationIdFromPanelTitle(fallbackTitle);

  return { kind: 'chat', conversationId, reuse: true };
}

function conversationIdFromPanelTitle(title: string): string | undefined {
  const prefix = 'LimCode: ';
  return title.startsWith(prefix) ? title.slice(prefix.length).trim() || undefined : undefined;
}

function metaFromState(value: unknown): WebviewClientMeta | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const kind = stringValue(record.kind);
  if (kind !== 'mainPanel' && kind !== 'globalSettings' && kind !== 'sidebar' && kind !== 'unknown') {
    return undefined;
  }

  const meta: WebviewClientMeta = { kind };
  const panelId = stringValue(record.panelId);
  const title = stringValue(record.title);
  const conversationId = stringValue(record.conversationId);
  if (panelId) meta.panelId = panelId;
  if (title) meta.title = title;
  if (conversationId) meta.conversationId = conversationId;
  return meta;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
