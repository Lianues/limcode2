import type * as vscode from 'vscode';
import type { LlmStartRequest } from '../world/modules/llm/contracts';
import type { WorldEvent } from '../ecs/types';

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
