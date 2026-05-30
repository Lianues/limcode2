import type * as vscode from 'vscode';
import type { LlmStartRequest } from '../world/modules/llm/contracts';
import type { WorldEvent } from '../ecs/types';
import type {
  BridgeClientId,
  ClientState,
  ExtensionToWebviewMessage,
  LlmSettingsRecord,
  WebviewClientMeta
} from '../../shared/protocol';

export type Emit = (event: WorldEvent) => void;

/** LLM 能力：无状态函数根据 request 启动流式执行，并通过 emit 回灌事件。 */
export interface LlmCapability {
  start(request: LlmStartRequest, emit: Emit): void;
}

/** 文件系统能力：隐藏 vscode.workspace.fs 等外部句柄。 */
export interface FsCapability {
  readFile(path: string, startLine?: number, endLine?: number): Promise<string>;
}

/** Webview 能力：集中管理多个 Webview client，真实 vscode.Webview 句柄不进入 ECS world。 */
export interface WebviewCapability {
  attach(webview: vscode.Webview, meta?: WebviewClientMeta): BridgeClientId;
  detach(clientId: BridgeClientId): void;
  detachAll(): void;
  subscribe(clientId: BridgeClientId, streamId: string): void;
  unsubscribe(clientId: BridgeClientId, streamId: string): void;
  post(clientId: BridgeClientId, message: ExtensionToWebviewMessage): void;
  broadcast(message: ExtensionToWebviewMessage): void;
  broadcastToStream(streamId: string, message: ExtensionToWebviewMessage): void;
  clientIds(): BridgeClientId[];
}

/** 插件数据目录：集中记录所有 VS Code 持久化数据的根位置。 */
export interface RuntimePaths {
  globalStorageUri: vscode.Uri;
  globalStoragePath: string;
  /** Agent 数据根目录：<globalStorage>/agents */
  agentsRootUri: vscode.Uri;
  agentsRootPath: string;
  agentsIndexUri: vscode.Uri;
  agentsIndexPath: string;
  /** Conversation/消息数据根目录：<globalStorage>/conversations */
  conversationsRootUri: vscode.Uri;
  conversationsRootPath: string;
  conversationsIndexUri: vscode.Uri;
  conversationsIndexPath: string;
  /** Agent 与 Conversation 的关系数据根目录：<globalStorage>/agent-conversation-links */
  linksRootUri: vscode.Uri;
  linksRootPath: string;
  linksIndexUri: vscode.Uri;
  linksIndexPath: string;
  /** 通用设置根目录：<globalStorage>/settings */
  settingsRootUri: vscode.Uri;
  settingsRootPath: string;
  /** LLM API 明文设置文件：<globalStorage>/settings/llm-api.json */
  llmSettingsUri: vscode.Uri;
  llmSettingsPath: string;
}

/** VS Code 存储能力：通过 workspace.fs 读写插件全局数据。 */
export interface StorageCapability {
  readonly paths: RuntimePaths;
  ensureReady(): Promise<void>;
  loadClientState(): Promise<ClientState | undefined>;
  saveClientState(state: ClientState): Promise<void>;
  loadLlmSettings(): Promise<LlmSettingsRecord>;
  saveLlmSettings(settings: LlmSettingsRecord): Promise<LlmSettingsRecord>;
}
