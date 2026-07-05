import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfigRecord, McpServersSettingsRecord, McpToolSourceRecord, InlineDataPart } from '../../shared/protocol';
import type { StorageCapability } from '../capabilities/types';
import type { ToolDefinition, ToolResultOut } from '../world/modules/tools/registry';

interface McpConnection {
  config: McpServerConfigRecord;
  client: Client;
  transport: { close(): Promise<void> };
  tools: ToolDefinition[];
  status: McpToolSourceRecord;
}

export class McpRuntimeManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly disabledSources = new Map<string, McpToolSourceRecord>();
  private refreshing = Promise.resolve();
  private onStateChange: (() => void) | undefined;

  public constructor(private readonly storage: StorageCapability) {}

  public setStateChangeListener(listener: (() => void) | undefined): void {
    this.onStateChange = listener;
  }

  public async refreshFromSettings(options: { discover: boolean } = { discover: true }): Promise<void> {
    this.refreshing = this.refreshing.then(() => this.refreshNow(options)).catch((error) => {
      console.warn('[LimCode] Failed to refresh MCP servers:', error);
    });
    return this.refreshing;
  }

  public async dispose(): Promise<void> {
    await Promise.all([...this.connections.values()].map((connection) => closeConnection(connection)));
    this.connections.clear();
    this.disabledSources.clear();
  }

  public runtimeTools(): ToolDefinition[] {
    return [...this.connections.values()].flatMap((connection) => connection.tools);
  }

  public sourceRecords(): McpToolSourceRecord[] {
    return [
      ...this.disabledSources.values(),
      ...[...this.connections.values()].map((connection) => connection.status)
    ].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id));
  }

  private async refreshNow(options: { discover: boolean }): Promise<void> {
    const loaded = await this.storage.loadGlobalSettings('mcpServers');
    const settings = loaded.settings as McpServersSettingsRecord;
    const wanted = new Map(settings.servers.map((server) => [server.id, server]));
    this.disabledSources.clear();
    let changed = false;

    for (const [id, connection] of [...this.connections]) {
      const next = wanted.get(id);
      if (!next || !next.enabled || !sameConnectionConfig(connection.config, next)) {
        await closeConnection(connection);
        this.connections.delete(id);
        changed = true;
      }
    }

    for (const server of settings.servers) {
      if (!server.enabled) {
        this.disabledSources.set(server.id, disabledSourceRecord(server));
        changed = true;
        continue;
      }
      if (this.connections.has(server.id)) continue;
      if (!options.discover) {
        this.disabledSources.set(server.id, idleSourceRecord(server));
        changed = true;
        continue;
      }
      const connecting = connectingSourceRecord(server);
      this.disabledSources.set(server.id, connecting);
      this.notifyStateChange();
      try {
        const connection = await connectServer(server);
        this.disabledSources.delete(server.id);
        this.connections.set(server.id, connection);
        changed = true;
        this.notifyStateChange();
      } catch (error) {
        this.disabledSources.set(server.id, { ...connecting, status: 'error', lastError: messageFromError(error), updatedAt: Date.now() });
        changed = true;
        this.notifyStateChange();
      }
    }
    if (changed) this.notifyStateChange();
  }

  private notifyStateChange(): void {
    this.onStateChange?.();
  }
}

async function connectServer(config: McpServerConfigRecord): Promise<McpConnection> {
  validateConnectableConfig(config);
  const client = new Client(
    { name: 'LimCode', version: '0.0.1' },
    { capabilities: {} }
  );
  const transport = config.transport.kind === 'stdio'
    ? new StdioClientTransport({
        command: config.transport.command,
        args: config.transport.args,
        env: { ...getDefaultEnvironment(), ...(config.transport.env ?? {}) },
        cwd: config.transport.cwd,
        stderr: 'pipe'
      })
    : new StreamableHTTPClientTransport(new URL(config.transport.url), {
        requestInit: config.transport.headers ? { headers: config.transport.headers } : undefined
      });
  await client.connect(transport);
  const listed = await client.listTools();
  const tools = listed.tools.map((tool) => mcpToolDefinition(config, client, tool));
  return {
    config,
    client,
    transport,
    tools,
    status: {
      id: config.id,
      name: config.name,
      transportKind: config.transport.kind,
      enabled: true,
      status: 'connected',
      toolCount: tools.length,
      updatedAt: Date.now()
    }
  };
}

function validateConnectableConfig(config: McpServerConfigRecord): void {
  if (config.transport.kind === 'stdio') {
    if (!config.transport.command.trim()) throw new Error('stdio MCP 服务缺少启动命令。');
    return;
  }
  const rawUrl = config.transport.url.trim();
  if (!rawUrl) throw new Error('HTTP MCP 服务缺少 URL。');
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL 必须使用 http 或 https。');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`HTTP MCP 服务 URL 无效：${detail}`);
  }
}

function mcpToolDefinition(source: McpServerConfigRecord, client: Client, tool: Tool): ToolDefinition {
  return {
    execution: 'runtime',
    declaration: {
      name: mcpToolDisplayName(source.name, tool.name),
      description: tool.description ?? `MCP 工具 ${tool.name}`,
      parameters: tool.inputSchema,
      source: {
        kind: 'mcp',
        sourceId: source.id,
        sourceName: source.name,
        originalToolName: tool.name
      },
      metadata: {
        category: 'general',
        scope: 'general',
        riskLevel: tool.annotations?.readOnlyHint ? 'read' : tool.annotations?.destructiveHint ? 'write' : 'command',
        readonly: tool.annotations?.readOnlyHint === true,
        defaultEnabled: false,
        defaultAutoApproveExecution: false,
        defaultAutoSubmitResult: true,
        defaultAutoApplyChange: false
      }
    },
    async execute(args, _deps, ctx): Promise<ToolResultOut> {
      const result = await client.callTool(
        { name: tool.name, arguments: isPlainRecord(args) ? args : {} },
        undefined,
        ctx?.signal ? { signal: ctx.signal } : undefined
      );
      return convertMcpToolResult(result);
    }
  };
}

function convertMcpToolResult(result: Awaited<ReturnType<Client['callTool']>>): ToolResultOut {
  if ('toolResult' in result) return { ok: true, output: result.toolResult };
  const text: string[] = [];
  const parts: InlineDataPart[] = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text') {
      text.push(item.text);
      continue;
    }
    if (item.type === 'image' || item.type === 'audio') {
      parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
      continue;
    }
    if (item.type === 'resource') {
      const resource = item.resource;
      if ('text' in resource) text.push(resource.text);
      else parts.push({ inlineData: { mimeType: resource.mimeType ?? 'application/octet-stream', data: resource.blob, name: resource.uri } });
      continue;
    }
    text.push(JSON.stringify(item));
  }
  const output = result.structuredContent ?? (text.length ? text.join('\n') : { content: result.content ?? [] });
  return { ok: result.isError !== true, output, ...(parts.length > 0 ? { parts } : {}) };
}

/**
 * AI 可见的工具名：`服务名_原始工具名`。服务名做 slug 保证字符合法，原始工具名保持原样以便和
 * MCP 服务自身文档一致。不含随机 id —— 唯一性由 {@link dedupeMcpToolNames} 在合并时兜底。
 */
function mcpToolDisplayName(sourceName: string, toolName: string): string {
  return `${slug(sourceName)}_${toolName}`;
}

/**
 * 就地消歧一批工具定义的名字：遇到与 `reserved`（含内置工具名）或彼此重名时追加 `_2`、`_3`…
 * 内部的 sourceId / originalToolName 不受影响，仅调整 AI 可见的 `declaration.name`。
 */
export function dedupeMcpToolNames(tools: ToolDefinition[], reserved: Iterable<string> = []): ToolDefinition[] {
  const used = new Set(reserved);
  return tools.map((tool) => {
    const base = tool.declaration.name;
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) name = `${base}_${suffix}`;
    used.add(name);
    return name === base ? tool : { ...tool, declaration: { ...tool.declaration, name } };
  });
}

function disabledSourceRecord(config: McpServerConfigRecord): McpToolSourceRecord {
  return {
    id: config.id,
    name: config.name,
    transportKind: config.transport.kind,
    enabled: false,
    status: 'disabled',
    toolCount: 0,
    updatedAt: config.updatedAt
  };
}

function idleSourceRecord(config: McpServerConfigRecord): McpToolSourceRecord {
  return {
    id: config.id,
    name: config.name,
    transportKind: config.transport.kind,
    enabled: true,
    status: 'idle',
    toolCount: 0,
    updatedAt: config.updatedAt
  };
}

function connectingSourceRecord(config: McpServerConfigRecord): McpToolSourceRecord {
  return {
    id: config.id,
    name: config.name,
    transportKind: config.transport.kind,
    enabled: true,
    status: 'connecting',
    toolCount: 0,
    updatedAt: Date.now()
  };
}

function sameConnectionConfig(left: McpServerConfigRecord, right: McpServerConfigRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function closeConnection(connection: McpConnection): Promise<void> {
  try {
    await connection.transport.close();
  } catch (error) {
    console.warn(`[LimCode] Failed to close MCP server ${connection.config.id}:`, error);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'tool';
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
