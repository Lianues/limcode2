export interface LoggedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * 独立包里默认不落盘日志；保留兼容函数签名，避免 transport 改动过大。
 */
export function logRequest(_logsDir: string, _request: LoggedRequest): string {
  return `${Date.now()}`;
}

/**
 * 独立包里默认不落盘日志；保留兼容函数签名。
 */
export function logResponse(_logsDir: string, _timestamp: string, _content: string, _stream: boolean): void {
  // no-op
}
