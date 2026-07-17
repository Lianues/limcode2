import * as vscode from 'vscode';
import {
  BridgeMessageType,
  createMessageId,
  type BridgeClientId,
  type OpenConversationPanelRecord,
  type PlanProposalOpenPayload,
  type WebviewClientMeta,
  type WebviewToExtensionMessage
} from '../../shared/protocol';
import { displayConversationTitle, displayConversationTitleFromText } from '../../shared/conversationTitle';
import { getWebviewHtml } from '../webview/getWebviewHtml';
import type { BackendApplication } from '../../backend/application/BackendApplication';

export interface MainPanelOptions {
  conversationId?: string;
  title?: string;
  kind?: 'chat' | 'globalSettings' | 'workflowSettings' | 'agentSettings' | 'planDetail';
  toolCallId?: string;
  planProposalId?: string;
  reuse?: boolean;
}

type MainPanelKind = 'chat' | 'globalSettings' | 'workflowSettings' | 'agentSettings' | 'planDetail';

const PANEL_TAB_TITLE_MAX_DISPLAY_UNITS = 20;
const PANEL_TAB_TITLE_ELLIPSIS = '...';

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
  private readonly toolCallId?: string;
  private readonly planProposalId?: string;
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
    this.toolCallId = options.toolCallId;
    this.planProposalId = options.planProposalId;

    this.refreshTitle(options.title);
    this.panel.webview.options = MainPanel.webviewPanelOptions(this.extensionUri);
    this.clientId = this.backendApp.attachWebview(panel.webview, {
      kind: this.kind === 'globalSettings' ? 'globalSettings' : this.kind === 'workflowSettings' ? 'workflowSettings' : this.kind === 'agentSettings' ? 'agentSettings' : this.kind === 'planDetail' ? 'planDetail' : 'mainPanel',
      panelId: this.panelId,
      title: this.panel.title,
      conversationId: this.conversationId,
      ...(this.toolCallId ? { toolCallId: this.toolCallId } : {}),
      ...(this.planProposalId ? { planProposalId: this.planProposalId } : {})
    });

    this.panel.webview.html = getWebviewHtml(this.panel.webview, this.extensionUri);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(() => MainPanel.notifyConversationPanelStateChanged(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        if (message.type === BridgeMessageType.ConversationOpen && message.payload?.conversationId) {
          MainPanel.createOrShow(this.extensionUri, this.backendApp, {
            conversationId: message.payload.conversationId,
            title: message.payload.title,
            reuse: true
          });
          return;
        }
        if (message.type === BridgeMessageType.ConversationCreate) {
          this.createConversationFromPanel(message.payload?.projectFolderUri);
          return;
        }
        if (message.type === BridgeMessageType.ConversationFork && message.payload) {
          this.forkConversationFromPanel(message.payload.sourceConversationId, message.payload.messageId);
          return;
        }
        if (message.type === BridgeMessageType.PlanProposalOpen && message.payload) {
          this.openPlanProposalFromPanel(message.payload);
          return;
        }
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

  private createConversationFromPanel(projectFolderUri?: string): void {
    const options = projectFolderUri?.trim() ? { projectFolderUri: projectFolderUri.trim() } : {};
    void this.backendApp
      .createConversation(options)
      .then((conversationId) => {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { conversationId });
      })
      .catch((error) => console.warn('[LimCode] Failed to create panel conversation.', error));
  }

  private openPlanProposalFromPanel(payload: PlanProposalOpenPayload): void {
    const conversationId = payload.conversationId?.trim() || this.conversationId;
    MainPanel.createOrShow(this.extensionUri, this.backendApp, {
      kind: 'planDetail',
      ...(conversationId ? { conversationId } : {}),
      ...(payload.toolCallId?.trim() ? { toolCallId: payload.toolCallId.trim() } : {}),
      ...(payload.planProposalId?.trim() ? { planProposalId: payload.planProposalId.trim() } : {}),
      ...(payload.title?.trim() ? { title: payload.title.trim() } : {}),
      reuse: true
    });
  }

  private forkConversationFromPanel(sourceConversationId: string, messageId: string): void {
    void this.backendApp
      .forkConversation(sourceConversationId, messageId)
      .then((conversationId) => {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { conversationId });
      })
      .catch((error) => {
        console.warn('[LimCode] Failed to fork panel conversation.', error);
        const message = error instanceof Error ? error.message : '无法创建分支对话。';
        void vscode.window.showErrorMessage(`LimCode: ${message}`);
      });
  }

  private matches(options: MainPanelOptions): boolean {
    const kind = panelKind(options);
    if (kind !== this.kind) return false;
    if (kind === 'globalSettings' || kind === 'workflowSettings' || kind === 'agentSettings') return true;
    if (kind === 'planDetail') {
      return (options.conversationId ?? '') === (this.conversationId ?? '')
        && (options.toolCallId ?? '') === (this.toolCallId ?? '')
        && (options.planProposalId ?? '') === (this.planProposalId ?? '');
    }
    return (options.conversationId ?? '') === (this.conversationId ?? '');
  }

  private refreshTitle(title?: string): void {
    this.panel.title = panelTitle({ kind: this.kind, conversationId: this.conversationId, title }, this.backendApp);
  }

  private panelWebviewMeta(): WebviewClientMeta {
    return {
      kind: this.kind === 'globalSettings' ? 'globalSettings' : this.kind === 'workflowSettings' ? 'workflowSettings' : this.kind === 'agentSettings' ? 'agentSettings' : this.kind === 'planDetail' ? 'planDetail' : 'mainPanel',
      panelId: this.panelId,
      title: this.panel.title,
      conversationId: this.conversationId,
      ...(this.toolCallId ? { toolCallId: this.toolCallId } : {}),
      ...(this.planProposalId ? { planProposalId: this.planProposalId } : {})
    };
  }

  private refreshTitleFromOutgoingMessage(message: WebviewToExtensionMessage): void {
    if (message.type !== BridgeMessageType.ChatSend) return;
    const payload = message.payload;
    if (!this.conversationId || !payload || payload.conversationId !== this.conversationId) return;
    if (!isDefaultConversationTitle(this.panel.title)) return;
    this.panel.title = panelTabTitle(displayConversationTitleFromText(payload.text ?? payload.content?.parts.map((part) => 'text' in part ? part.text : '').join('\n') ?? ''));
  }

  public static refreshConversationTitle(conversationId: string): void {
    for (const panel of MainPanel.panels.values()) {
      if (panel.conversationId === conversationId) panel.refreshTitle();
    }
  }

  public static closePanelsByConversationId(conversationId: string): void {
    for (const panel of [...MainPanel.panels.values()]) {
      if (panel.kind === 'chat' && panel.conversationId === conversationId) {
        panel.panel.dispose();
      }
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
  if (options.kind === 'planDetail') return 'planDetail';
  if (options.kind === 'agentSettings') return 'agentSettings';
  if (options.kind === 'workflowSettings') return 'workflowSettings';
  return options.kind === 'globalSettings' ? 'globalSettings' : 'chat';
}

function panelTitle(options: MainPanelOptions, backendApp: BackendApplication): string {
  if (options.kind === 'globalSettings') return 'LimCode 设置';
  if (options.kind === 'workflowSettings') return 'LimCode 工作流编辑';
  if (options.kind === 'agentSettings') return 'LimCode Agent 设置';
  if (options.kind === 'planDetail') return panelTabTitle(options.title?.trim() || 'Plan 详情');
  if (!options.conversationId) return panelTabTitle('LimCode');
  const title = options.title
    ? displayConversationTitle({ id: options.conversationId, title: options.title })
    : backendApp.getConversationDisplayTitle(options.conversationId);
  return panelTabTitle(title);
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
  const isWorkflowSettings =
    serializedKind === 'workflowSettings' ||
    meta?.kind === 'workflowSettings' ||
    fallbackTitle === 'LimCode 工作流编辑';
  const isAgentSettings =
    serializedKind === 'agentSettings' ||
    meta?.kind === 'agentSettings' ||
    fallbackTitle === 'LimCode Agent 设置';
  const isPlanDetail = serializedKind === 'planDetail' || meta?.kind === 'planDetail';

  if (isGlobalSettings) {
    return { kind: 'globalSettings', reuse: true };
  }
  if (isWorkflowSettings) {
    return { kind: 'workflowSettings', reuse: true };
  }
  if (isAgentSettings) {
    return { kind: 'agentSettings', reuse: true };
  }
  if (isPlanDetail) {
    return {
      kind: 'planDetail',
      conversationId: meta?.conversationId,
      toolCallId: meta?.toolCallId,
      planProposalId: meta?.planProposalId,
      title: meta?.title,
      reuse: true
    };
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
  if (kind !== 'mainPanel' && kind !== 'globalSettings' && kind !== 'workflowSettings' && kind !== 'agentSettings' && kind !== 'planDetail' && kind !== 'sidebar' && kind !== 'unknown') {
    return undefined;
  }

  const meta: WebviewClientMeta = { kind };
  const panelId = stringValue(record.panelId);
  const title = stringValue(record.title);
  const conversationId = stringValue(record.conversationId);
  const toolCallId = stringValue(record.toolCallId);
  const planProposalId = stringValue(record.planProposalId);
  if (panelId) meta.panelId = panelId;
  if (title) meta.title = title;
  if (conversationId) meta.conversationId = conversationId;
  if (toolCallId) meta.toolCallId = toolCallId;
  if (planProposalId) meta.planProposalId = planProposalId;
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

function panelTabTitle(title: string): string {
  return ellipsizeDisplayText(
    title,
    PANEL_TAB_TITLE_MAX_DISPLAY_UNITS,
    PANEL_TAB_TITLE_ELLIPSIS
  );
}

function ellipsizeDisplayText(title: string, maxDisplayUnits: number, ellipsis: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (!normalized) return title;
  if (displayUnits(normalized) <= maxDisplayUnits) return normalized;

  const ellipsisUnits = displayUnits(ellipsis);
  const contentMaxUnits = Math.max(1, maxDisplayUnits - ellipsisUnits);
  let currentUnits = 0;
  let result = '';

  for (const char of normalized) {
    const nextUnits = currentUnits + displayUnits(char);
    if (nextUnits > contentMaxUnits) break;
    currentUnits = nextUnits;
    result += char;
  }

  return `${result.trimEnd()}${ellipsis}`;
}

function displayUnits(text: string): number {
  let units = 0;
  for (const char of text) units += isWideCharacter(char) ? 2 : 1;
  return units;
}

function isWideCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  return codePoint >= 0x1f300 || /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char);
}
