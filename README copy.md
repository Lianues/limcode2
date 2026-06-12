# unified-llm-provider

统一 LLM 接口 npm 包。

它的目标不是让用户自己处理各家格式差异，而是：

- 你可以只维护一种输入/输出格式
- 你可以显式指定要把请求体**转成什么格式**
- `thoughtSignature` / `thoughtSignatures` 会跟着请求体格式一起处理
- 不需要单独再指定“签名格式类型”

---

## 当前内置支持

- `unified`：包的统一格式（推荐用户长期维护这个）
- `gemini`
- `claude`
- `openai-compatible`
- `openai-responses`
- `deepseek`（wire format 视为 `openai-compatible`）

---

## 设计原则

### 1. 用户主要关心的是“格式 from/to”

不是：
- 我该把签名声明成 Gemini 还是 Claude？

而是：
- 我现在手里的请求体是什么格式？
- 我要把它转成什么格式？

签名会随格式转换一起处理。

### 1.1 一个最重要的例子

假设：

- 用户维护的是 `claude` 格式历史
- 历史里已有 `claude` 原生签名
- 这次实际要调用的是 `gemini`

那么规则是：

1. `from = claude`
2. 实际 provider = `gemini`
3. 组装 Gemini 请求时，只找 **Gemini 可用签名**
4. 如果当前历史里没有 `gemini:` 对应签名，就等价于 **这轮不传签名**
5. 模型返回后，如果你要继续返回 `claude` 格式给用户，那么 `signature` 字段会写成 `gemini:xxxx`，因为这条签名实际属于 Gemini

### 2. 不伪造跨 provider 原生签名

### 2.1 OpenAI 系前缀现在明确拆分

为了避免歧义，这个包不再把 OpenAI 系签名统称成 `openai:`。

现在公开前缀建议是：

- `openai-compatible:`
- `openai-responses:`

旧的 `openai:` 输入已删除。
如果你之前使用过 `openai:`，现在必须明确改成 `openai-compatible:` 或 `openai-responses:`。


这个包会：
- 自动识别签名
- 自动归一化
- 自动带上统一前缀（在 `unified` 输出里）
- 自动放回目标格式对应的位置

但**不会**做这种错误事情：
- 把 Gemini 原生签名“变成”Claude 原生签名
- 把 Claude 原生签名“变成”OpenAI 原生签名

也就是说：
- Claude 签名仍然是 Claude 签名
- OpenAI Compatible 扩展签名仍然是 `openai-compatible` 签名
- OpenAI Responses `encrypted_content` 仍然是 `openai-responses` 签名
- Gemini thought signature 仍然是 Gemini 签名

---

## `unified` 格式是什么

`unified` 是这个包对外推荐的统一格式。

它基于 Gemini-like message 结构，但额外兼容：

- `thoughtSignature: string`
- `thoughtSignatures: { [provider]: string }`

其中 `provider` 推荐使用完整命名空间：`gemini | claude | openai-compatible | openai-responses`

典型例子：

```ts
const request = {
  contents: [
    { role: 'user', parts: [{ text: 'hello' }] },
    {
      role: 'model',
      parts: [
        {
          text: 'thinking...',
          thought: true,
          thoughtSignature: 'claude:sig_xxx',
        },
        { text: 'final answer' },
      ],
    },
  ],
};
```


### UsageMetadata / token 用量

`unified` 响应里的 `usageMetadata` 沿用 Gemini-like 的核心字段，并在此基础上补充少量跨 provider 都有实际意义的明细字段。

```ts
interface UsageMetadata {
  /** 输入侧 token 总数。Claude 下包含 input + cache creation + cache read。 */
  promptTokenCount?: number;

  /** 缓存命中 / cache read token 数。 */
  cachedContentTokenCount?: number;

  /** 输出 token 数。对支持 reasoning/thinking 的模型，通常已包含思考 token。 */
  candidatesTokenCount?: number;

  /** 请求总 token 数。注意：它已经包含 thoughtsTokenCount，不要再额外相加。 */
  totalTokenCount?: number;

  /** 思考 / 推理 token 明细。 */
  thoughtsTokenCount?: number;

  /** Claude cache creation token，已包含在 promptTokenCount 内。 */
  cacheCreationInputTokenCount?: number;

  /** Claude cache creation 的 TTL 级明细。 */
  cacheCreationInputTokensDetails?: {
    ephemeral5mInputTokenCount?: number;
    ephemeral1hInputTokenCount?: number;
  };
}
```

核心规则：

- `promptTokenCount` 表示输入侧总量；对于 Claude，它等于 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`。
- `cachedContentTokenCount` 表示缓存命中 / cache read，不额外增加新的 cache miss 字段。
- `cacheCreationInputTokenCount` 是缓存创建明细，已经包含在 `promptTokenCount` 内，不应再次相加。
- `thoughtsTokenCount` 是思考 token 明细，已经包含在 provider 返回的输出/总量中，不应再次加到 `totalTokenCount`。
- `totalTokenCount` 优先使用 provider 返回的总量；没有原生总量时才按现有字段回退计算。
- Gemini 的 modality 详情、`toolUsePromptTokenCount`、`toolUsePromptTokensDetails`、`cacheTokensDetails`、`serviceTier` 等字段不会进入 `unified`，会在解码时过滤。

#### usage 字段映射

| unified 字段 | Claude | OpenAI-compatible | OpenAI Responses | Gemini |
|---|---|---|---|---|
| `promptTokenCount` | `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` | `prompt_tokens` | `input_tokens` | `promptTokenCount` |
| `cachedContentTokenCount` | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` 或 `prompt_cache_hit_tokens` | `input_tokens_details.cached_tokens` | `cachedContentTokenCount` |
| `cacheCreationInputTokenCount` | `cache_creation_input_tokens` | - | - | - |
| `cacheCreationInputTokensDetails.ephemeral5mInputTokenCount` | `cache_creation.ephemeral_5m_input_tokens` | - | - | - |
| `cacheCreationInputTokensDetails.ephemeral1hInputTokenCount` | `cache_creation.ephemeral_1h_input_tokens` | - | - | - |
| `candidatesTokenCount` | `output_tokens` | `completion_tokens` | `output_tokens` | `candidatesTokenCount` |
| `thoughtsTokenCount` | `output_tokens_details.thinking_tokens` | `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` | `thoughtsTokenCount` |
| `totalTokenCount` | `promptTokenCount + output_tokens` 或 provider 总量 | `total_tokens` | `total_tokens` | `totalTokenCount` |

#### 示例：Claude cache creation + thinking tokens

Claude 原始 usage：

```json
{
  "input_tokens": 8,
  "cache_creation_input_tokens": 5120,
  "cache_read_input_tokens": 0,
  "cache_creation": {
    "ephemeral_5m_input_tokens": 5120,
    "ephemeral_1h_input_tokens": 0
  },
  "output_tokens": 348,
  "output_tokens_details": {
    "thinking_tokens": 312
  }
}
```

转换成 `unified` 后：

```json
{
  "promptTokenCount": 5128,
  "cachedContentTokenCount": 0,
  "cacheCreationInputTokenCount": 5120,
  "cacheCreationInputTokensDetails": {
    "ephemeral5mInputTokenCount": 5120,
    "ephemeral1hInputTokenCount": 0
  },
  "candidatesTokenCount": 348,
  "thoughtsTokenCount": 312,
  "totalTokenCount": 5476
}
```

这里 `totalTokenCount = promptTokenCount + candidatesTokenCount`，而 `thoughtsTokenCount` 只是 `candidatesTokenCount` 里的明细，不再额外相加。

---

## 安装

```bash
npm install unified-llm-provider
```

---

## 最常用的两种方式

## 方式 1：直接做格式转换

### `convertRequest`

把一个请求体从 A 格式转成 B 格式。

```ts
import { convertRequest } from 'unified-llm-provider';

const claudeRequest = convertRequest({
  contents: [
    { role: 'user', parts: [{ text: 'hello' }] },
    {
      role: 'model',
      parts: [
        {
          text: 'deep thought',
          thought: true,
          thoughtSignature: 'claude:sig_req_1',
        },
      ],
    },
  ],
}, {
  from: 'unified',
  to: 'claude',
  model: 'claude-sonnet-4',
});
```

这里你只指定：
- `from: 'unified'`
- `to: 'claude'`

签名会自动跟着请求体转换到 Claude 的 `thinking.signature` 位置。

---

### `convertResponse`

把一个响应体从 A 格式转成 B 格式。

```ts
import { convertResponse } from 'unified-llm-provider';

const unifiedResponse = convertResponse({
  content: [
    { type: 'thinking', thinking: 'let me think', signature: 'sig_resp_1' },
    { type: 'text', text: 'done' },
  ],
  stop_reason: 'end_turn',
}, {
  from: 'claude',
  to: 'unified',
});
```

输出里会自动变成：

```ts
thoughtSignature: 'claude:sig_resp_1'
```

---

### `createStreamConverter`

把流式 chunk / event 从一种格式转成另一种格式。

```ts
import { createStreamConverter } from 'unified-llm-provider';

const converter = createStreamConverter({
  from: 'claude',
  to: 'unified',
});

const chunk = converter.convert({
  type: 'content_block_delta',
  delta: { type: 'signature_delta', signature: 'sig_stream_1' },
});
```

---

## 方式 2：直接调用 provider，但输入输出格式可自选

### `provider.chat()`

你可以调用一个实际 provider，但输入和输出不一定要等于它自己的原生格式。

比如：
- 实际调用的是 Claude
- 输入给包的是 `openai-compatible`
- 输出要回 `unified`

```ts
import { createClaudeProvider } from 'unified-llm-provider';

const provider = createClaudeProvider({
  provider: 'claude',
  model: 'claude-sonnet-4',
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const response = await provider.chat({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'You are helpful' },
    { role: 'user', content: 'hello' },
  ],
}, {
  inputFormat: 'openai-compatible',
  outputFormat: 'unified',
});
```

流程会是：

```text
openai-compatible request
  -> decode to unified canonical
  -> encode to claude request
  -> call Claude API
  -> decode Claude response
  -> encode back to unified response
```

签名也跟着这条链一起走，不用你单独声明“签名转成什么格式”。

### Dry Run：只构建请求，不发送

如果你只想展示或复制“这次真实会发给 provider 的 HTTP 请求”，可以使用 `provider.dryRun()`。

```ts
const dry = await provider.dryRun(
  {
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  },
  {
    inputFormat: 'unified',
    outputFormat: 'unified',
    stream: true,
    curl: { includeApiKey: false },
  }
);

console.log(dry.curl);
console.log(dry.url);
console.log(dry.headers);
console.log(dry.body);
```

返回结果包含：

```ts
dry.url;       // 最终请求 URL
dry.headers;   // 最终请求 headers（结构化对象）
dry.body;      // 最终 provider 请求体（结构化对象）
dry.bodyText;  // JSON 文本，方便展示/复制
dry.curl;      // 可复制的 curl 命令
```

说明：

- `dryRun` 会走真实 provider 编码逻辑，复用 `chat` / `chatStream` 的请求构建路径；
- `dryRun` 不发送网络请求，也不会调用 `fetch`；
- `curl` 默认隐藏 API Key（`includeApiKey: false`），避免 UI 展示时泄漏密钥；
- 如果确实需要展示 API Key，可以显式传 `curl: { includeApiKey: true }`；
- `stream: true` 时生成和 `chatStream` 相同的流式请求；
- `stream: false` 时生成和 `chat` 相同的非流式请求。

---

## Router / Factory

### 创建内置注册表

```ts
import { createBootstrapExtensionRegistry } from 'unified-llm-provider';

const registry = createBootstrapExtensionRegistry();
```

### 通过 factory 创建 provider

```ts
import { createBootstrapExtensionRegistry, createLLMFromConfig } from 'unified-llm-provider';

const registry = createBootstrapExtensionRegistry();
const provider = createLLMFromConfig({
  provider: 'claude',
  model: 'claude-sonnet-4',
  apiKey: process.env.ANTHROPIC_API_KEY,
  proxy: 'http://127.0.0.1:7890', // 可选：显式指定 HTTP/HTTPS 代理
  endpoint: {
    url: 'https://example.com/custom/messages',
    headers: {
      'x-endpoint-header': 'demo',
    },
  },
  headers: {
    'x-top-header': 'top',
  },
  requestBody: {
    metadata: { source: 'my-app' },
  },
}, registry.llmProviders);
```

支持：
- 自定义 `url`
- 自定义 `streamUrl`
- 自定义 `headers`
- 自定义 `requestBody`
- 自定义 `fetch`
- 自定义超时
- 显式指定 `proxy`

---

### 统一生成参数与 `requestBody` 覆盖规则

统一请求体只把最常用的生成参数作为一等字段，命名采用 Gemini-like camelCase：

```ts
const request = {
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  generationConfig: {
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    maxOutputTokens: 1024,
    thinkingConfig: {
      includeThoughts: true,
      thinkingBudget: 10000,
      thinkingLevel: 'high',
    },
  },
};
```

当前保证映射的字段：

| unified / Gemini-like | Gemini | Claude | OpenAI Chat Completions | OpenAI Responses |
|---|---|---|---|---|
| `temperature` | `generationConfig.temperature` | `temperature` | `temperature` | `temperature` |
| `topP` | `generationConfig.topP` | `top_p` | `top_p` | `top_p` |
| `topK` | `generationConfig.topK` | `top_k` | 默认不映射 | 默认不映射 |
| `maxOutputTokens` | `generationConfig.maxOutputTokens` | `max_tokens` | `max_tokens` | `max_output_tokens` |
| `thinkingConfig.includeThoughts` | `generationConfig.thinkingConfig.includeThoughts` | 忽略 | 忽略 | 忽略 |
| `thinkingConfig.thinkingBudget` | `generationConfig.thinkingConfig.thinkingBudget`；未显式传 `includeThoughts` 时自动补 `includeThoughts: true` | 无有效 `thinkingLevel` 时映射为 `thinking: { type: 'enabled', budget_tokens }` | 默认不映射 | 默认不映射 |
| `thinkingConfig.thinkingLevel` | 仅支持 `minimal/low/medium/high` | 支持 `none/low/medium/high/xhigh/max` | 支持 `none/minimal/low/medium/high/xhigh` | 支持 `none/minimal/low/medium/high/xhigh` |

思考参数规则：

- `not-set` / `non-set` 表示不发送思考等级相关字段，让上游按默认策略处理。
- 对某个 provider 不属于自身支持集合的 `thinkingLevel`，也按 `not-set` 处理，不发送对应思考字段。
- `includeThoughts` 只对 Gemini 原生请求有效；Claude / OpenAI 系会忽略统一字段里的 `includeThoughts`。
- 传入 `thinkingBudget` 或有效的 `thinkingLevel` 且没有显式传 `includeThoughts` 时，Gemini 请求里会自动补 `includeThoughts: true`；如果显式传 `includeThoughts: false`，则保留 `false`。

各 provider 的 `thinkingLevel` 映射：

| provider | 支持等级 | 映射 |
|---|---|---|
| Gemini | `minimal/low/medium/high` | `generationConfig.thinkingConfig.thinkingLevel = level`，并在未显式传 `includeThoughts` 时补 `includeThoughts: true` |
| Claude | `none` | `thinking: { type: 'disabled' }` |
| Claude | `low/medium/high/xhigh/max` | `thinking: { type: 'adaptive' }` + `output_config: { effort: level }` |
| OpenAI Chat / OpenAI Compatible | `none/minimal/low/medium/high/xhigh` | `reasoning_effort = level` |
| OpenAI Responses | `none/minimal/low/medium/high/xhigh` | `reasoning: { effort: level, summary: 'auto' }` |
| DeepSeek | `none` | `thinking: { type: 'disabled' }` |
| DeepSeek | `high/max` | `thinking: { type: 'enabled' }` + `reasoning_effort = level` |

Claude 的 `thinkingBudget` 映射为：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

如果同时传入 Claude 支持的 `thinkingLevel` 和 `thinkingBudget`，优先使用 `thinkingLevel` 的映射；如需强制改写最终 provider 原生字段，可用 `requestBody` 覆盖。


`requestBody` 是 provider 原生请求体补丁，会在格式转换完成后再深合并到最终 body，因此它可以覆盖上面这些统一参数生成出来的字段：

```ts
const provider = createLLMFromConfig({
  provider: 'openai-compatible',
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  requestBody: {
    // 覆盖 generationConfig.temperature / topP / maxOutputTokens 转换后的结果
    temperature: 0.2,
    top_p: 0.95,
    max_tokens: 2048,
  },
}, registry.llmProviders);
```

对于 Gemini，覆盖路径保持 Gemini 原生结构：

```ts
requestBody: {
  generationConfig: {
    temperature: 0.2,
    topP: 0.95,
    topK: 32,
    maxOutputTokens: 2048,
  },
}
```

优先级规则：

1. 统一请求体 `generationConfig` 先转换成目标 provider 请求体；
2. `config.requestBody` 再合并，覆盖统一参数生成的同名 provider 字段；
3. 运行时 `patchRequestBodyOverrides()` 最后合并，优先级最高。

---


### 获取模型列表：`listAvailableModels()`

可以通过 `listAvailableModels()` 拉取 provider 的模型列表，并按用户指定格式返回。

```ts
import { listAvailableModels } from 'unified-llm-provider';

// 默认返回 unified 统一格式：{ provider, baseUrl, models: UnifiedModelInfo[] }
const unified = await listAvailableModels({
  provider: 'openai-compatible',
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: 'https://api.openai.com/v1',
});

// 也可以直接返回目标 API 的模型列表格式
const openAIStyle = await listAvailableModels({
  provider: 'gemini',
  apiKey: process.env.GEMINI_API_KEY,
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  outputFormat: 'openai-compatible',
});
```

支持的返回格式：

- `unified`：包内统一简化格式，默认值；
- `openai-compatible` / `openai-responses` / `deepseek` / `openai`：OpenAI `GET /v1/models` 风格：`{ object: 'list', data: [...] }`；
- `claude`：Anthropic `GET /v1/models` 风格：`{ data: [...] }`；
- `gemini`：Gemini `GET /v1beta/models` 风格：`{ models: [...] }`。

#### `unified` 模型字段

`unified` 的模型条目统一使用 Gemini 风格字段：Gemini 原生有的字段直接复用；其它 provider 的信息映射到同义字段；Gemini 没有但其它 provider 有价值的信息，用新增的 camelCase 字段保存。

```ts
interface UnifiedModelInfo {
  /** 可直接用于调用接口的模型 ID。Gemini 优先用 baseModelId；没有时用去掉 models/ 前缀后的 name。 */
  id: string;

  /** Gemini 风格模型名。Gemini 通常为 models/xxx；OAI/Claude 使用自身 id。 */
  name: string;

  /** 展示名。上游没有 displayName/display_name 时回退为 id。 */
  displayName: string;

  /** Gemini 原生字段。只有上游提供或可明确映射时才返回。 */
  baseModelId?: string;
  version?: string;
  description?: string;
  inputTokenLimit?: number;   // Claude max_input_tokens 会映射到这里
  outputTokenLimit?: number;  // Claude max_tokens 会映射到这里
  supportedGenerationMethods?: string[];
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;

  /** 新增统一字段。 */
  ownedBy?: string;       // OpenAI owned_by / owner
  createdAt?: string;     // Claude created_at；OpenAI created 会转换为 ISO 字符串
  modelType?: string;     // OpenAI object / Claude type
  capabilities?: unknown; // Claude capabilities 等能力详情

  /** 兼容旧版 UI 的展示标签。 */
  label?: string;

  /** 上游原始模型对象，用于保留 provider 私有字段和无损转换。 */
  raw?: unknown;
}
```

映射规则：

| 上游 | unified 字段 |
|---|---|
| Gemini `name` | `name`；同时去掉 `models/` 后可作为 `id` 回退 |
| Gemini `baseModelId` / `displayName` / `inputTokenLimit` / `outputTokenLimit` / `supportedGenerationMethods` / 采样参数 | 同名 camelCase 字段 |
| OpenAI `id` | `id`、`name`、`displayName` 回退 |
| OpenAI `owned_by` / `created` / `object` | `ownedBy` / `createdAt` + `created` / `modelType` |
| Claude `id` / `display_name` / `created_at` / `type` | `id` + `name` / `displayName` / `createdAt` / `modelType` |
| Claude `max_input_tokens` / `max_tokens` / `capabilities` | `inputTokenLimit` / `outputTokenLimit` / `capabilities` |

实际请求端点：

| provider | 请求端点 | 认证 |
|---|---|---|
| OpenAI 兼容 / OpenAI Responses / DeepSeek | `GET {baseUrl}/models?limit=1000`，如返回 `has_more` 会继续用 `after={last_id}` 拉取后续页 | `Authorization: Bearer ...` |
| Claude | `GET {baseUrl}/models?limit=1000`，如返回 `has_more` 会继续用 `after_id={last_id}` 拉取后续页 | `x-api-key` + `anthropic-version: 2023-06-01` |
| Gemini | `GET {baseUrl}/models?key=...&pageSize=1000`，如返回 `nextPageToken` 会继续分页 | query 参数 `key=` |

说明：

- 默认 `pageSize` / `limit` 为 `1000`，避免只拿到默认分页的 100 条；可通过 `pageSize` 覆盖。
- 如果上游仍然返回分页游标，会在内部自动继续拉取直到完整列表；返回给下游时不暴露 `nextPageToken` / `first_id` / `last_id` / `has_more` 这类分页字段。
- 返回模型对象时会尽量保留上游原始字段，并放在统一字段和 `raw` 中；转换格式时只补齐目标格式必要结构字段（如顶层 `object: 'list'`、模型 `id` / `name` / `displayName`）。
- 对 `created`、`owned_by`、`capabilities`、`supportedGenerationMethods` 等可选信息：上游提供就保留或映射；上游没有提供就不返回该字段。
- Gemini 会优先使用 `baseModelId` 作为对外模型 `id`；没有显示名称（`displayName` / `display_name`）时，会直接使用 `id`。
- `format` 可作为 `outputFormat` 的别名。

---

### 显式指定代理

可以在 provider 配置上直接传代理地址：

```ts
const provider = createLLMFromConfig({
  provider: 'openai-compatible',
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: 'https://api.openai.com/v1',
  proxy: 'http://127.0.0.1:7890',
}, registry.llmProviders);
```

也可以按 endpoint 单独覆盖：

```ts
endpoint: {
  url: 'https://example.com/v1/chat/completions',
  proxy: { url: 'http://127.0.0.1:7890' },
}
```

显式配置 `proxy` 时，内部会使用 `undici.ProxyAgent`，并对目标请求设置 `requestTls.rejectUnauthorized=false`，方便调试/抓包代理处理 HTTPS。

单次调用也可以临时覆盖：

```ts
await provider.chat(request, {
  proxy: 'http://127.0.0.1:7890',
});
```

---

### 创建 router

```ts
import { createBootstrapExtensionRegistry, createLLMRouter } from 'unified-llm-provider';

const registry = createBootstrapExtensionRegistry();

const router = createLLMRouter({
  defaultModelName: 'main',
  models: [
    {
      modelName: 'main',
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      apiKey: process.env.GEMINI_API_KEY,
    },
    {
      modelName: 'backup',
      provider: 'claude',
      model: 'claude-sonnet-4',
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
  ],
}, undefined, registry.llmProviders);
```

---

## thought signature 规则

## 输入兼容两种写法

### 字符串写法

```ts
thoughtSignature: 'claude:sig_xxx'
```

### 对象写法

```ts
thoughtSignatures: {
  claude: 'sig_xxx'
}
```

---

## 你现在不需要再单独指定“签名格式类型”

你主要只需要指定：

- `from`
- `to`

或者：

- `inputFormat`
- `outputFormat`

签名会跟着格式走。

### 具体来说是什么意思？

比如你传入的是 `claude` 格式：

```ts
await provider.chat(claudeLikeHistory, {
  inputFormat: 'claude',
  // 实际 provider 是 gemini
  // outputFormat 不写时，默认回到 inputFormat，也就是 claude
});
```

此时：

- 请求发给 Gemini 之前，会先检查历史里有没有 `gemini` 可用签名
- 如果只有 `claude` 原生签名，没有 `gemini:` 前缀签名，那么就**不把 Claude 签名错误地发给 Gemini**
- Gemini 返回后，再编码回 `claude` 格式
- 但返回给你的 `claude` thinking block 里的 `signature` 会是：

```ts
signature: 'gemini:xxxx'
```

同理，如果实际调用的是 `openai-responses`，那么回到其他结构时会写成 `openai-responses:xxxx`，不会再写成模糊的 `openai:xxxx`。

这样你下次继续把这份 `claude` 格式历史传回来时，包就能知道：这不是 Claude 原生签名，而是 Gemini 原生签名，只是被保存在 Claude 风格结构里。

---

## `unified` 输出时的默认策略

### 默认优先字符串

如果结果里只有一个可明确归属的签名，`unified` 输出默认会是：

```ts
thoughtSignature: 'claude:sig_xxx'
```

### 如果你的 `unified` 输入本来就是对象签名

在 `provider.chat(..., { inputFormat: 'unified', outputFormat: 'unified' })` 这类场景里，
如果你原本传的是：

```ts
thoughtSignatures: { claude: 'sig_xxx' }
```

包会尽量延续对象形式。

### 高级场景仍可手动控制

底层 `encode* / convert*` API 仍然保留 `signatureMode` 这样的高级参数，
但正常使用时，你通常不需要碰它。

## 调试与请求/响应日志

这个包不会主动往终端打印任何内容。它只负责把数据通过回调或对象交给你，**显示到哪里完全由你决定**。

---

### 方式 1：trace 模式 — 数据存进对象，你自己取用

```ts
import { createTraceDebugHooks, type DebugTraceStore } from 'unified-llm-provider';

const trace = {} as DebugTraceStore;

const provider = createClaudeProvider({
  provider: 'claude',
  model: 'claude-sonnet-4',
  apiKey: process.env.ANTHROPIC_API_KEY,
  debug: createTraceDebugHooks(trace),
});

await provider.chat({
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
});

// 现在 trace 对象里有你需要的一切
console.log(trace.request!.curl);            // 完整的 curl 命令
console.log(trace.response!.status);         // HTTP 状态码
console.log(trace.response!.bodyText);       // 响应体文本
console.log(trace.streamChunks);             // 流式 chunk 数组
```

---

### 方式 2：file 模式 — 必须显式指定路径

```ts
import { createFileDebugHooks } from 'unified-llm-provider';

const provider = createClaudeProvider({
  // ...
  debug: createFileDebugHooks('./logs/debug.log'),
});

// 也支持绝对路径
debug: createFileDebugHooks('C:/LIANUE/logs/debug.log'),

// 支持 ~ 展开为用户主目录
debug: createFileDebugHooks('~/.iris/logs/debug.log'),
```

路径规则：
- 相对路径：`./logs/debug.log`
- 绝对路径：`C:/path/to/debug.log` 或 `/home/user/debug.log`
- `~` 展开：`~/.iris/logs/debug.log` 会自动变成 `/home/用户名/.iris/logs/debug.log`

每次请求会把 `curl` 命令和响应自动追加到这个文件里。


### 方式 2.1：split 模式 — 请求和响应分两个文件，用时间戳关联

如果想把请求和响应分成两个独立文件，用日期时间命名关联：

```ts
import { createSplitFileDebugHooks } from 'unified-llm-provider';

const provider = createClaudeProvider({
  // ...
  debug: createSplitFileDebugHooks('./logs'),
});
```

每次请求会在 `./logs/` 下生成两个文件：

```text
logs/
  req_2026-05-23T08-30-15-123Z.log   ← 请求体
  resp_2026-05-23T08-30-15-123Z.log  ← 响应体
```

两个文件共享同一个时间戳前缀，可以在文件管理器里自然排列在一起。

同样支持 `~` 展开：

```ts
debug: createSplitFileDebugHooks('~/.iris/llm-logs'),
```


---

### 方式 3：自定义 hooks — 完全自由

```ts
const provider = createClaudeProvider({
  debug: {
    onRequest(event) {
      // url, headers, body
      myLogger.info('LLM Request', event);
    },
    onResponse(event) {
      // status, headers, bodyText, error?
      if (event.error) {
        myLogger.error('LLM Error', event);
      } else {
        myLogger.info('LLM Response', event);
      }
    },
    onStreamChunk(event) {
      // chunk, accumulated（实时流式回调）
      myUI.appendStreamingText(event.chunk);
    },
  },
});
```

---

### 三个回调说明

| 回调 | 触发时机 | 适用场景 |
|---|---|---|
| `onRequest` | 请求发出前 | 非流式 + 流式 |
| `onResponse` | 非流式：拿到完整响应后 / 流式：全部 SSE 收完后 | 非流式 + 流式 |
| `onStreamChunk` | 每个 SSE chunk 实时到达时 | 仅流式 |

---

### 辅助格式化工具

这些工具也可以单独使用：

```ts
import {
  formatRequestAsCurl,   // 把请求格式化成 curl 命令
  formatResponseForLog,  // 把响应格式化成易读日志
  bodyToCurlPayload,     // 把 body 格式化成 JSON
} from 'unified-llm-provider';

const curl = formatRequestAsCurl(
  'https://api.anthropic.com/v1/messages',
  { 'x-api-key': 'sk-xxx', 'content-type': 'application/json' },
  { model: 'claude', messages: [{ role: 'user', content: 'hello' }] },
  { includeApiKey: false },  // 可选：隐藏 API Key
);

console.log(curl);
```

输出示例：

```text
curl -X POST 'https://api.anthropic.com/v1/messages' \
  -H 'x-api-key: ***' \
  -H 'content-type: application/json' \
  -d '{"model":"claude","messages":[{"role":"user","content":"hello"}]}'
```

---

### 设计原则

- **我们只负责把数据交给你**
- **不往终端打印，不抢 stdout**
- **写文件必须显式指定路径**
- **trace 对象是你的，你决定怎么用**

---

## 推荐实践

### 最推荐

- 长期维护 `unified`
- 真正发请求时按需转成目标 provider 格式
- 返回时再转回 `unified`

这样用户业务代码最稳定。

### 适合中转网关 / 兼容层

- 上游输入 `openai-compatible`
- 下游实际调用 `claude`
- 输出再转回 `openai-compatible` 或 `unified`

---

## 当前状态

当前包已完成：

- 独立 `package.json`
- TypeScript 构建
- Vitest 测试
- 内置 provider / format 注册表
- request / response / stream from-to 转换
- provider 调用桥接
- thought signature 跟随格式自动处理
- 调试钩子 `onRequest` / `onResponse` / `onStreamChunk`
- 显式代理配置 `proxy`
- 模型列表拉取与 OpenAI / Claude / Gemini 格式转换

已验证通过：

```bash
npm run test
npm run build
```



## 社区支持

- [LinuxDO](https://linux.do)