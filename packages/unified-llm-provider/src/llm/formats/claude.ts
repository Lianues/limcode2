/**
 * Claude/Anthropic 格式适配器
 *
 * Gemini ↔ Claude API 格式的完整双向转换。
 */

import {
  LLMRequest, LLMResponse, LLMStreamChunk, Part, FunctionCallPart, FunctionResponsePart,
  isTextPart, isVisibleTextPart, isInlineDataPart, isFunctionCallPart, isFunctionResponsePart,
} from '../../types.js';
import type { LLMPromptCacheConfig, LLMPromptCacheTtl } from '../../config/types.js';
import { FormatAdapter, StreamDecodeState } from './types.js';
import { consumeCallId, normalizeCallId, resolveCallId } from './tool-call-ids.js';
import { sanitizeSchemaForClaude } from './schema-sanitizer.js';
import { mapClaudeThinkingLevel } from './thinking-level.js';
import { isToolResponseDocumentMimeType, isToolResponseImageMimeType } from '../vision.js';

interface NormalizedClaudePromptCacheConfig {
  enabled: boolean;
  ttl?: Extract<LLMPromptCacheTtl, '1h'>;
  auto: boolean;
  breakpoints: {
    system: boolean;
    tools: boolean;
    messages: boolean;
  };
}

export class ClaudeFormat implements FormatAdapter {
  private readonly promptCache: NormalizedClaudePromptCacheConfig;

  constructor(
    private model: string,
    promptCacheOrPromptCaching?: LLMPromptCacheConfig | boolean,
    autoCaching?: boolean,
  ) {
    this.promptCache = normalizeClaudePromptCacheConfig(promptCacheOrPromptCaching, autoCaching);
  }

  // ============ 编码请求：Gemini → Claude ============

  encodeRequest(request: LLMRequest, stream?: boolean): unknown {
    const body: Record<string, unknown> = { model: this.model };

    // systemInstruction → system 字符串
    if (request.systemInstruction?.parts) {
      const text = request.systemInstruction.parts
        .filter(isVisibleTextPart).map(p => p.text).join('\n');
      if (text) body.system = text;
    }

    // contents → messages
    const messages: Record<string, unknown>[] = [];
    const pendingToolUseIds: string[] = [];
    let generatedToolUseIdCounter = 0;

    for (const content of request.contents) {
      const textParts = content.parts.filter(isVisibleTextPart);
      const funcCallParts = content.parts.filter(isFunctionCallPart);
      const funcRespParts = content.parts.filter(isFunctionResponsePart);

      if (content.role === 'model') {
        const contentBlocks: Record<string, unknown>[] = [];

        // 思考部分 (Claude Thinking) — 必须在 text 之前。
        // 即便没有 Claude 签名，也保留 thought 文本，避免跨格式转换时丢失 reasoning/thinking 内容。
        for (const part of content.parts) {
          if (!isTextPart(part) || part.thought !== true) continue;
          const sig = part.thoughtSignatures?.claude;
          const thinkingText = part.text || '';
          if (!thinkingText && !sig) continue;
          contentBlocks.push({
            type: 'thinking',
            thinking: thinkingText,
            ...(sig ? { signature: sig } : {}),
          });
        }

        // 文本部分
        for (const part of textParts) {
          if (!isTextPart(part)) continue;
          if (part.text) contentBlocks.push({ type: 'text', text: part.text });
        }

        // 工具调用部分
        for (const part of funcCallParts) {
          if (!isFunctionCallPart(part)) continue;
          const toolUseId = resolveCallId(part.functionCall.callId, `toolu_${generatedToolUseIdCounter++}`);
          contentBlocks.push({
            type: 'tool_use',
            id: toolUseId,
            name: part.functionCall.name,
            input: part.functionCall.args,
          });
          pendingToolUseIds.push(toolUseId);
        }

        if (contentBlocks.length > 0) {
          messages.push({ role: 'assistant', content: contentBlocks });
        }
      } else {
        // user role
        if (funcRespParts.length > 0) {
          const contentBlocks: Record<string, unknown>[] = [];
          for (const part of funcRespParts) {
            if (!isFunctionResponsePart(part)) continue;
            const toolUseId = consumeCallId({
              explicit: part.functionResponse.callId,
              pendingCallIds: pendingToolUseIds,
              providerLabel: 'Claude',
              toolName: part.functionResponse.name,
            });
            contentBlocks.push({
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: encodeClaudeToolResultContent(part.functionResponse),
            });
          }
          messages.push({ role: 'user', content: contentBlocks });
        } else {
          const contentBlocks: Record<string, unknown>[] = [];
          let hasStructuredContent = false;

          for (const part of content.parts) {
            if (isTextPart(part) && part.thought !== true && part.text) {
              contentBlocks.push({ type: 'text', text: part.text });
            } else if (isInlineDataPart(part)) {
              hasStructuredContent = true;
              const mime = part.inlineData.mimeType;
              contentBlocks.push({
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: mime,
                  data: part.inlineData.data,
                },
              });
            }
          }

          if (hasStructuredContent) {
            messages.push({ role: 'user', content: contentBlocks });
          } else {
            const text = textParts.map(p => {
              if (!isTextPart(p)) throw new Error('unreachable');
              return p.text;
            }).join('');
            messages.push({ role: 'user', content: text });
          }
        }
      }
    }

    body.messages = messages;

    // tools 声明转换
    if (request.tools && request.tools.length > 0) {
      const allDecls = request.tools.flatMap(t => Array.isArray((t as any).functionDeclarations) ? (t as any).functionDeclarations : []);
      body.tools = allDecls.map(decl => ({
        name: decl.name,
        description: decl.description,
        input_schema: sanitizeSchemaForClaude(decl.parameters) ?? { type: 'object', properties: {} },
      }));
    }

    // generationConfig 转换（Claude 要求必填 max_tokens）
    const gc = request.generationConfig;
    body.max_tokens = gc?.maxOutputTokens ?? 16000;
    if (gc?.temperature !== undefined) body.temperature = gc.temperature;
    if (gc?.topP !== undefined) body.top_p = gc.topP;
    if (gc?.topK !== undefined) body.top_k = gc.topK;

    const thinkingLevel = mapClaudeThinkingLevel(gc?.thinkingConfig?.thinkingLevel);
    if (thinkingLevel === 'none') {
      body.thinking = { type: 'disabled' };
    } else if (thinkingLevel) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: thinkingLevel };
    } else if (typeof gc?.thinkingConfig?.thinkingBudget === 'number') {
      body.thinking = {
        type: 'enabled',
        budget_tokens: gc.thinkingConfig.thinkingBudget,
      };
    }

    // 流式参数
    if (stream) body.stream = true;

    // 启用手动缓存断点时，注入 Prompt Caching 标记。
    // 遵循 Anthropic 的缓存前缀层级：tools → system → messages。
    // 最多 3 个断点（Anthropic 允许最多 4 个）。
    if (this.promptCache.enabled) {
      this.injectCacheBreakpoints(body, this.promptCache);
    }

    // 注入顶层自动缓存标记。
    // 服务端会自动将断点放置在最后一个可缓存的内容块上。
    if (this.promptCache.auto) {
      (body as any).cache_control = createClaudeCacheControl(this.promptCache);
    }

    return body;
  }

  // ============ 解码响应：Claude → Gemini ============

  decodeResponse(raw: unknown): LLMResponse {
    const data = raw as any;
    const parts: Part[] = [];

    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input,
              callId: normalizeCallId(block.id),
            },
          });
        } else if (block.type === 'thinking') {
          // Claude thinking block: { type: "thinking", thinking: "思考文本", signature: "签名" }
          parts.push({
            text: block.thinking || '',
            thought: true,
            thoughtSignatures: { claude: block.signature },
          });
        }
      }
    }
    if (parts.length === 0) parts.push({ text: '' });

    // stop_reason 映射
    const finishReason = mapStopReason(data.stop_reason);

    return {
      content: { role: 'model', parts },
      finishReason,
      usageMetadata: data.usage
        ? buildClaudeUsageMetadata(data.usage)
        : undefined,
    };
  }

  // ============ 流式解码 ============

  decodeStreamChunk(raw: unknown, state: StreamDecodeState): LLMStreamChunk {
    const data = raw as any;
    const chunk: LLMStreamChunk = {};
    const st = state as ClaudeStreamState;

    switch (data.type) {
      case 'message_start':
        // input_tokens 通常在 message_start 回传；但部分上游（如智谱 GLM 的
        // Anthropic 兼容端点）在此处回传 0，真实值放在 message_delta。两处都会
        // ingest，取较大值，因此顺序与是否重复都不影响结果。
        ingestClaudeUsageIntoState(st, data.message?.usage);
        break;

      case 'content_block_start':
        if (data.content_block?.type === 'tool_use') {
          st.currentToolUse = {
            id: data.content_block.id,
            name: data.content_block.name,
            arguments: '',
          };
        } else if (data.content_block?.type === 'thinking') {
          // 标记进入 thinking block
          st.inThinkingBlock = true;
        }
        break;

      case 'content_block_delta':
        if (data.delta?.type === 'text_delta') {
          chunk.textDelta = data.delta.text;
        } else if (data.delta?.type === 'thinking_delta') {
          // Claude thinking 流式文本：delta.thinking 包含可读的思考文本
          chunk.partsDelta = [{
            text: data.delta.thinking || '',
            thought: true,
          } as any];
        } else if (data.delta?.type === 'signature_delta') {
          // Claude thinking 签名：在 thinking block 结束前发送
          // 仅存签名，不含文本，用于多轮回传
          chunk.partsDelta = [{
            thought: true,
            thoughtSignatures: { claude: data.delta.signature },
          } as any];
          if (!chunk.thoughtSignatures) chunk.thoughtSignatures = {};
          chunk.thoughtSignatures.claude = data.delta.signature;
        } else if (data.delta?.type === 'input_json_delta') {
          if (st.currentToolUse) {
            st.currentToolUse.arguments += data.delta.partial_json;
          }
        }
        break;

      case 'content_block_stop':
        if (st.currentToolUse) {
          // 流式边执行优化：content_block_stop 意味着该工具的参数已完整流完，
          // 立即输出 functionCall 而不是攒到 message_delta。
          // 这样 callLLMStream 的 onFunctionCallReady 回调可以在流式期间
          // 逐个触发，让 StreamingToolExecutor 提前启动工具执行。
          const completedCall: FunctionCallPart = {
            functionCall: {
              name: st.currentToolUse.name,
              args: st.currentToolUse.arguments
                ? JSON.parse(st.currentToolUse.arguments)
                : {},
              callId: st.currentToolUse.id,
            },
          };
          if (!chunk.functionCalls) chunk.functionCalls = [];
          chunk.functionCalls.push(completedCall);
          st.currentToolUse = null;
        }
        if (st.inThinkingBlock) {
          st.inThinkingBlock = false;
        }
        break;

      case 'message_delta':
        if (data.delta?.stop_reason) {
          chunk.finishReason = mapStopReason(data.delta.stop_reason);
          // 工具调用已在 content_block_stop 时逐个输出，这里不再需要批量输出
        }
        if (data.usage) {
          // 官方 Claude 会在 message_delta 中重复回传 input_tokens/cache 字段；
          // 智谱 GLM 则只在这里回传真实的 input_tokens。统一在此再次 ingest。
          ingestClaudeUsageIntoState(st, data.usage);
          const outputTokens = data.usage.output_tokens ?? 0;
          const thinkingTokens = data.usage.output_tokens_details?.thinking_tokens;
          chunk.usageMetadata = {
            promptTokenCount: st.inputTokens ?? 0,
            ...((st.hasCachedContentTokens || (st.cachedContentTokens ?? 0) > 0) ? { cachedContentTokenCount: st.cachedContentTokens ?? 0 } : {}),
            ...(st.hasCacheCreationInputTokens ? { cacheCreationInputTokenCount: st.cacheCreationInputTokens ?? 0 } : {}),
            ...(st.cacheCreationInputTokensDetails ? { cacheCreationInputTokensDetails: st.cacheCreationInputTokensDetails } : {}),
            ...(typeof thinkingTokens === 'number' ? { thoughtsTokenCount: thinkingTokens } : {}),
            candidatesTokenCount: data.usage.output_tokens,
            totalTokenCount: (st.inputTokens ?? 0) + outputTokens,
          };
        }
        break;

      // ping 等事件忽略
    }

    return chunk;
  }

  createStreamState(): StreamDecodeState {
    return {
      currentToolUse: null,
      inputTokens: 0,
      hasCachedContentTokens: false,
      hasCacheCreationInputTokens: false,
      // pendingFunctionCalls 已废弃：工具调用现在在 content_block_stop 时立即输出，
      // 不再需要攒到 message_delta 批量输出。保留字段兼容 ClaudeStreamState 接口。
      inThinkingBlock: false,
    } as ClaudeStreamState;
  }

  /**
   * 为 Anthropic Prompt Caching 注入手动缓存断点。
   *
   * 缓存前缀层级（顺序重要）：
   *   1. tools    — 标记最后一个工具定义
   *   2. system   — 将字符串转换为 content-block 数组，标记最后一个块
   *   3. messages — 标记最后一条用户消息的最后一个内容块
   */
  private injectCacheBreakpoints(body: Record<string, unknown>, config: NormalizedClaudePromptCacheConfig): void {
    const cacheControl = createClaudeCacheControl(config);

    // 1. 标记最后一个工具定义
    const tools = body.tools as any[] | undefined;
    if (config.breakpoints.tools && tools && tools.length > 0) {
      tools[tools.length - 1].cache_control = cacheControl;
    }

    // 2. 将 system 从字符串转换为 content-block 数组并标记。
    //    Anthropic 接受 system 为字符串或内容块数组；
    //    需要数组形式才能附加 cache_control。
    if (config.breakpoints.system && typeof body.system === 'string' && body.system) {
      body.system = [
        { type: 'text', text: body.system, cache_control: cacheControl },
      ];
    } else if (config.breakpoints.system && Array.isArray(body.system) && body.system.length > 0) {
      (body.system as any[])[body.system.length - 1].cache_control = cacheControl;
    }

    // 3. 标记最后一条用户消息的最后一个内容块。
    //    这会缓存整个对话历史前缀。
    const messages = body.messages as any[] | undefined;
    if (config.breakpoints.messages && messages && messages.length > 0) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user') continue;

        // Plain-text user messages use content as a string; convert to
        // content-block array so we can attach cache_control.
        if (typeof msg.content === 'string') {
          msg.content = [{ type: 'text', text: msg.content }];
        }

        if (!Array.isArray(msg.content) || msg.content.length === 0) continue;
        const lastBlock = msg.content[msg.content.length - 1];
        lastBlock.cache_control = cacheControl;
        break;
      }
    }
  }
}

function normalizeClaudePromptCacheConfig(
  input: LLMPromptCacheConfig | boolean | undefined,
  autoCaching?: boolean,
): NormalizedClaudePromptCacheConfig {
  const fromObject = input && typeof input === 'object' && !Array.isArray(input) ? input : undefined;
  const enabled = fromObject ? fromObject.enabled !== false : input === true;
  const breakpoints = fromObject?.breakpoints ?? {};
  return {
    enabled,
    ...(fromObject?.ttl === '1h' ? { ttl: '1h' as const } : {}),
    auto: autoCaching === true,
    breakpoints: {
      system: breakpoints.system !== false,
      tools: breakpoints.tools !== false,
      messages: breakpoints.messages !== false,
    },
  };
}

function createClaudeCacheControl(config: NormalizedClaudePromptCacheConfig): Record<string, string> {
  return {
    type: 'ephemeral',
    ...(config.ttl === '1h' ? { ttl: '1h' } : {}),
  };
}

interface ClaudeStreamState extends StreamDecodeState {
  currentToolUse: { id: string; name: string; arguments: string } | null;
  inputTokens: number;
  hasCachedContentTokens?: boolean;
  cachedContentTokens?: number;
  hasCacheCreationInputTokens?: boolean;
  cacheCreationInputTokens?: number;
  cacheCreationInputTokensDetails?: NonNullable<LLMResponse['usageMetadata']>['cacheCreationInputTokensDetails'];
  inThinkingBlock: boolean;
}

function hasOwn(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * 将一个 Claude usage 对象（来自 message_start 或 message_delta）合并进流式状态。
 *
 * 兼容两类上游：
 *  - 官方 Claude：input_tokens/cache_* 在 message_start 就位，message_delta 会重复回传相同值；
 *  - 智谱 GLM 兼容端点：message_start 的 input_tokens 为 0，真实值只在 message_delta 出现。
 *
 * 因此对 input 总量取「已见过的最大值」，避免 delta 里的 0 覆盖 start 里的正确值，
 * 也避免 start 里的 0 压制 delta 里的真实值。cache 字段一旦出现即记录。
 */
function ingestClaudeUsageIntoState(st: ClaudeStreamState, usage: any): void {
  if (!usage || typeof usage !== 'object') return;

  const mergedInput = (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
  if (mergedInput > (st.inputTokens ?? 0)) {
    st.inputTokens = mergedInput;
  }

  if (hasOwn(usage, 'cache_read_input_tokens')) {
    st.hasCachedContentTokens = true;
    st.cachedContentTokens = usage.cache_read_input_tokens ?? 0;
  }
  if (hasOwn(usage, 'cache_creation_input_tokens')) {
    st.hasCacheCreationInputTokens = true;
    st.cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  }
  const details = decodeCacheCreationInputTokensDetails(usage.cache_creation);
  if (details) {
    st.cacheCreationInputTokensDetails = details;
  }
}

function decodeCacheCreationInputTokensDetails(
  raw: unknown,
): NonNullable<LLMResponse['usageMetadata']>['cacheCreationInputTokensDetails'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const data = raw as any;
  const details: NonNullable<LLMResponse['usageMetadata']>['cacheCreationInputTokensDetails'] = {};

  if (typeof data.ephemeral_5m_input_tokens === 'number') {
    details.ephemeral5mInputTokenCount = data.ephemeral_5m_input_tokens;
  }
  if (typeof data.ephemeral_1h_input_tokens === 'number') {
    details.ephemeral1hInputTokenCount = data.ephemeral_1h_input_tokens;
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function buildClaudeUsageMetadata(usage: any): LLMResponse['usageMetadata'] {
  const inputBase = usage.input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const promptTotal = inputBase + cacheCreation + cacheRead;
  const thinkingTokens = usage.output_tokens_details?.thinking_tokens;
  const cacheCreationDetails = decodeCacheCreationInputTokensDetails(usage.cache_creation);

  return {
    promptTokenCount: promptTotal,
    ...((hasOwn(usage, 'cache_read_input_tokens') || cacheRead > 0) ? { cachedContentTokenCount: cacheRead } : {}),
    ...(hasOwn(usage, 'cache_creation_input_tokens') ? { cacheCreationInputTokenCount: cacheCreation } : {}),
    ...(cacheCreationDetails ? { cacheCreationInputTokensDetails: cacheCreationDetails } : {}),
    ...(typeof thinkingTokens === 'number' ? { thoughtsTokenCount: thinkingTokens } : {}),
    candidatesTokenCount: usage.output_tokens,
    totalTokenCount: promptTotal + output,
  };
}

function encodeClaudeToolResultContent(response: FunctionResponsePart['functionResponse']): unknown {
  const text = JSON.stringify(response.response);
  const mediaBlocks = (response.parts ?? [])
    .map(part => encodeClaudeToolResultMediaBlock(part))
    .filter((block): block is Record<string, unknown> => !!block);

  if (mediaBlocks.length === 0) return text;
  return [
    { type: 'text', text },
    ...mediaBlocks,
  ];
}

function encodeClaudeToolResultMediaBlock(part: NonNullable<FunctionResponsePart['functionResponse']['parts']>[number]): Record<string, unknown> | undefined {
  const inlineData = part.inlineData;
  const mime = inlineData.mimeType;
  if (isToolResponseImageMimeType(mime)) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mime,
        data: inlineData.data,
      },
    };
  }
  if (isToolResponseDocumentMimeType(mime)) {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: mime,
        data: inlineData.data,
      },
    };
  }
  return undefined;
}


function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'end_turn': return 'STOP';
    case 'tool_use': return 'TOOL_CALLS';
    case 'max_tokens': return 'MAX_TOKENS';
    case 'stop_sequence': return 'STOP';
    default: return reason ?? 'STOP';
  }
}
