/**
 * IDE 无关的宿主通信契约。
 *
 * 任何具体 IDE（VS Code / 未来其它 IDE）只需实现这个接口；
 * 上层 transport / stores / components 都只依赖 HostApi，不直接依赖任何具体 IDE API。
 * 这样迁移到其它 IDE 时，只需新增一个 HostApi 实现并在 createHostApi 中注册。
 */
export interface HostApi {
  /** 向宿主（扩展后端）发送一条消息。 */
  postMessage(message: unknown): void;
  /** 订阅来自宿主的消息，返回取消订阅函数。 */
  onMessage(handler: (message: unknown) => void): () => void;
  /** 读取宿主持久化的 webview 状态。 */
  getState<TState>(): TState | undefined;
  /** 写入宿主持久化的 webview 状态。 */
  setState<TState>(state: TState): void;
}
