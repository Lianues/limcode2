import type * as vscode from 'vscode';
import type { LlmStartRequest } from '../world/modules/llm/contracts';
import type { WorldEvent } from '../ecs/types';
import type { ClientState } from '../../shared/protocol';

export type Emit = (event: WorldEvent) => void;

/** LLM 能力：无状态函数根据 request 启动流式执行，并通过 emit 回灌事件。 */
export interface LlmCapability {
  start(request: LlmStartRequest, emit: Emit): void;
}

/** 文件系统能力：隐藏 vscode.workspace.fs 等外部句柄。 */
export interface FsCapability {
  readFile(path: string, startLine?: number, endLine?: number): Promise<string>;
}

/** Webview 能力：当前 webview 是可变外部句柄，集中封装在 RuntimeEnv 中。 */
export interface WebviewCapability {
  attach(webview: vscode.Webview): void;
  detach(): void;
  post(message: unknown): void;
}

/** 插件数据目录：集中记录所有 VS Code 持久化数据的根位置。 */
export interface RuntimePaths {
  globalStorageUri: vscode.Uri;
  globalStoragePath: string;
  /** 分块对话数据根目录：<globalStorage>/chat */
  chatRootUri: vscode.Uri;
  chatRootPath: string;
  /** 对话索引入口：<globalStorage>/chat/manifest.json */
  chatManifestUri: vscode.Uri;
  chatManifestPath: string;
}

/** VS Code 存储能力：通过 workspace.fs 读写插件全局数据。 */
export interface StorageCapability {
  readonly paths: RuntimePaths;
  ensureReady(): Promise<void>;
  loadClientState(): Promise<ClientState | undefined>;
  saveClientState(state: ClientState): Promise<void>;
}
