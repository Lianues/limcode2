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

已验证通过：

```bash
npm run test
npm run build
```
