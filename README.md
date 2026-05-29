# LimCode

LimCode 是一个 VS Code 扩展原型：后端使用 TypeScript ECS world，前端使用 Vue Webview，当前已接入最基础的 AI 对话链路。

## 当前能力

- 主 Webview 提供基础 AI 对话界面。
- Webview 通过 bridge 发送 `chat:send`，后端 ECS chat systems 生成 assistant 消息并触发 `llm.start` effect。
- LLM driver 使用 OpenAI-compatible Chat Completions 接口，默认配置为 Deepseek：
  - Base URL: `https://api.deepseek.com/v1`
  - Model: `deepseek-v4-flash`
- 会话历史通过 VS Code `globalStorageUri` 持久化到 `chat-history.json`。
- `RuntimeEnv.paths` 记录插件全局数据目录和历史文件路径。

> 不建议把 API Key 写进仓库。请使用命令 `LimCode: Configure OpenAI Compatible API Key` 保存到 VS Code SecretStorage，或设置环境变量 `LIMCODE_OPENAI_API_KEY` / `DEEPSEEK_API_KEY`。

## 快速开始

```bash
npm install
npm run build
```

然后在 VS Code 中按 `F5` 启动 Extension Development Host。

常用命令：

```text
LimCode: Open AI Chat
LimCode: Configure OpenAI Compatible API Key
LimCode: Reveal Global Storage Folder
```

## 常用脚本

```bash
npm run compile          # 编译扩展后端 TS
npm run watch            # 监听并编译扩展后端 TS
npm run dev:webview      # 启动 Vue Webview Vite dev server
npm run build:webview    # 构建 Webview 静态资源
npm run build            # 编译后端 + 构建 Webview
npm run check            # 编译后端 + Webview 类型检查
```

## 目录概览

```text
backend/                 # ECS world、application composition root、capabilities
shared/                  # Webview 与扩展共享协议
vscode/                  # VS Code extension entry、commands、panels、views
webview/                 # Vue Webview 前端
```
