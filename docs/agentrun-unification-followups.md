# AgentRun 大一统重构后续事项

本文件记录当前 AgentRun 大一统重构已经完成的基线，以及尚未完整实现、后续需要继续推进的事项。

## 当前基线

当前代码已经完成第一版统一执行核心，并通过：

```bash
npm run check
```

已完成的核心能力：

- 引入 `AgentRun` 作为统一执行单元。
- 普通聊天入口改为创建 `AgentRun(kind='chat')`。
- `sub_agent` 工具改为 ECS-managed tool，创建 child `AgentRun`。
- LLM 请求改为 run-scoped：`LlmRequest { run, conversation, modelMessage }`。
- ToolCall 改为 run-scoped：通过 `ToolCallRunLink` 找所属 run。
- `ModelProfile / SystemPrompt / ToolPolicy / ApprovalPolicy` 纳入 Run 级解析体系。
- `ToolPolicy` 与 `ApprovalPolicy` 拆分。
- 协议主线从 `Session/sessionId` 改为 `Conversation/conversationId`。
- 不做自动 diff / 自动修改记录 / RunChangeSet，工作区变更由模型通过工具主动查询。

## 本轮已补齐

以下事项已在本轮补齐，并通过 `npm run check`：

- 完成命名清理：公共协议与主要前后端内部变量改为 `conversation` 命名；前端 store 使用 `currentConversationId / conversations`。
- 新增 `ConversationReuseLink` 与 `ConversationBranchLink`，用于持久表达复用 conversation 与 fork/branch 关系。
- `sub_agent` 的 conversation policy resolver 已支持：
  - `same` / `same_conversation`
  - `fresh` / `new` / `new_conversation`
  - `reuse` / `reuse_conversation`
  - `fork` / `fork_conversation`
  - `branch` / `branch_from_revision`
- `fork_conversation` 已支持按历史策略投影消息：`full`、`none`、`last_n`、`selected_messages`、`since_message`、`summary`（summary 为确定性文本投影，不调用 LLM 总结）。
- `branch_from_revision` 已支持从指定 `MessageRevision` 复制到该消息为止的历史，并使用指定 revision 内容替换对应消息。
- Webview MVP 增加 conversation 列表、visibility badge、hidden 显示开关与 conversation 切换。

## 尚未完整做完的事项

### 1. 多 Agent 委派入口尚未实现

核心已经能表达：

```text
AgentRunSourceLink
AgentRunTargetLink
RunDeliveryPolicy
```

但还没有实现独立入口，例如：

```text
delegate_to_agent 工具
UI 手动委派按钮
Reviewer/Planner/Coder 等 Agent 显式调度入口
```

后续应把这些入口都做成“创建 AgentRun”的薄入口，而不是另起一套执行核心。

---

### 2. ConversationPolicy 后续增强

当前结构上已经有并已跑通主要 resolver：

```ts
RunConversationPolicy.mode:
  | 'same_conversation'
  | 'new_conversation'
  | 'reuse_conversation'
  | 'fork_conversation'
  | 'branch_from_revision'
```

已实现：

- `reuse_conversation`：按 `reuseKey` 找到并复用长期 conversation；不存在时创建并写入 `ConversationReuseLink`。
- `fork_conversation`：从父 conversation 按 history policy 复制/投影历史到新 conversation，并写入 `ConversationBranchLink(kind='fork')`。
- `branch_from_revision`：从指定 message revision 创建分支，并写入 `ConversationBranchLink(kind='branch_from_revision')`。
- conversation visibility MVP：对话列表展示 visibility badge，支持显示 hidden。

后续仍可增强：

- branch 支持 conversation-level revision，而不仅是 message revision。
- fork/branch UI 更明确地展示来源链路和父子关系。
- reuseKey 管理 UI，例如查看/解除某个 key 的绑定。
- summary history 使用真正的摘要模型，而不是当前的确定性文本投影。

---

### 3. ContextPolicy 还只是基础版(已完成)

当前 `RunContextPolicy` 已有结构：

```ts
historyMode: 'none' | 'full' | 'last_n' | 'since_message' | 'selected_messages' | 'summary'
```

目前 runtime 主要支持：

- `full`
- `none` 的简单末条消息处理
- `last_n`

尚未完整实现：

- `since_message`
- `selected_messages`
- `summary`
- `includeSourceContext`
- `includeSourceToolResult`
- subagent 参数里的 `conversation.history='selected'` 等高级策略映射。

后续应让 ContextAssembly 真正根据 policy 裁剪/组装上下文。



已实现内容

1. 新增 ContextPolicy 组装核心

新增：
backend/world/modules/agentRun/contextPolicy.ts
用于统一构建 run-scoped LLM context，支持：

- full
- none
- last_n
- since_message
- selected_messages
- summary

并且保证：

- historyMode='none' 不再只是简单取最后一条消息；
- 会始终保留当前 run 的必要消息：
  - input message
  - 已完成 model message
  - tool response message
- 所以工具调用后的 functionCall/functionResponse 链不会被 ContextPolicy 裁剪坏。

2. summary 支持确定性文本投影

summary 现在会生成临时 synthetic MessageContent：
[Context summary]
user m123: ...
model m124: ...
...
特点：

- 不落盘；
- 不创建 Message 实体；
- 不引入额外 LLM 摘要调用；
- function call / function response 会转成安全文本描述，避免污染当前 run 的工具调用链。

真正的 LLM 摘要模型仍保留为后续增强。

3. 支持 source context / source tool result 注入

RunContextPolicy 中已有的字段现在开始生效：
includeSourceContext?: boolean;
includeSourceToolResult?: boolean;
对应能力：

- includeSourceContext=true
  - 把 source conversation 中按 history policy 选出的上下文作为文本块注入 child run。
- includeSourceToolResult=true
  - 把 source tool call 的 args/status/result/error/progress 注入 child run。

4. 改造 LlmDispatchSystem

修改：
backend/world/modules/chat/systems/LlmDispatchSystem.ts
现在不再使用本地简化版 applyContextPolicy()，而是调用新的：
buildRunContextContents(...)
同时补齐了 worker snapshot access 声明，避免 parallelWorkers: true 下读不到 run/mode/policy/link 组件。

5. 修复 active Run policy override 不生效问题

修改：
backend/world/modules/agentRun/queries.ts
现在：

- activeContextPolicyForRun()
- activeDeliveryPolicyForRun()

会在多个 active policy link 中选择最新创建/最新实体的 link。

这样 spawnAgentRun() 默认创建的 policy 不会覆盖后续 sub_agent 写入的 run override policy。

6. 完善 sub_agent 参数映射

修改：
backend/world/modules/tools/definitions/subAgent/index.ts
backend/world/modules/tools/systems/ToolDispatchSystem.ts
新增 schema/type 支持：
conversation: {
  includeSourceContext?: boolean;
  includeSourceToolResult?: boolean;
}
并写入 RunContextPolicy。

同时处理了 fork_conversation / branch_from_revision 的上下文语义：  
因为 fork/branch 已经把所需历史投影到了目标 conversation，child run 的 context policy 会使用 full 读取目标投影，避免 selectedMessageIds/sinceMessageId 使用源 message id 再过滤克隆 message 时丢失上下文。

修改文件
backend/world/modules/agentRun/contextPolicy.ts
backend/world/modules/agentRun/index.ts
backend/world/modules/agentRun/queries.ts
backend/world/modules/chat/systems/LlmDispatchSystem.ts
backend/world/modules/tools/definitions/subAgent/index.ts
backend/world/modules/tools/systems/ToolDispatchSystem.ts
验证结果

已执行并通过：
npm run check
没有引入自动 diff、自动 workspace snapshot、自动修改归因，仍然保持文档要求的 AgentRun 核心边界。
23:14  943.8s  ↑187,875(187,392)  ↓1,101   40.1 t/s

---

### 4. sub_agent mode 全套参数还未完全落地

`sub_agent` 工具 schema 里已经暴露了完整 mode 覆盖入口：

```ts
mode: {
  modeId?: string;
  systemPromptId?: string;
  modelProfileId?: string;
  toolPolicyId?: string;
  approvalPolicyId?: string;
  contextPolicyId?: string;
  deliveryPolicyId?: string;
  editPolicyId?: string;
}
```

当前 runtime 已实现的 run override：

- `modeId`
- `systemPromptId`
- `modelProfileId`
- `toolPolicyId`
- `approvalPolicyId`

尚未完整实现：

- `contextPolicyId`
- `deliveryPolicyId`
- `editPolicyId`
- inline 创建临时 policy 的能力。
- subagent type/blueprint 的默认 conversation/context/delivery/edit policy 全量落地。

---

### 5. DeliveryPolicy 只完成核心路径

当前主要跑通：

- `tool_response`：同步 child run 完成后，把结果写回父 tool call。
- `notification`：后台 child run 完成后，往 source conversation 写 notification，并创建 source notification run。
- `direct_reply`：普通聊天自然落在目标 conversation。

尚未完整实现：

- `append_to_source_conversation`
- `silent`
- `includeTranscript='link' | 'selected' | 'full'` 的严格语义。
- child conversation transcript 的可追踪链接展示。
- notification XML 的结构化增强，例如 summary、executor、conversationId、runId、usage 等。

---

### 6. Message Revision / 编辑请求只完成数据结构

当前已经有：

```ts
MessageRevision
MessageCurrentRevisionLink
AgentRunInputRevision
RunEditPolicy
```

但后续还需要实现：

- Webview 编辑 message 的交互。
- 编辑后创建新 `MessageRevision`。
- Run 启动时记录 `AgentRunInputRevision` 的完整逻辑。
- `RunEditPolicy.onSourceEdited` 行为：
  - `ignore_snapshot`
  - `abort_and_restart`
  - `append_correction`
  - `branch_new_run`
  - `mark_stale`
- `RunEditPolicy.onNewUserMessageWhileRunning` 行为：
  - `queue_next_run`
  - `interrupt_current`
  - `append_to_target`
  - `ignore`

---

### 7. Webview UI 仍是 MVP

当前 Webview 已能通过类型检查，并适配 `conversationId` payload。

已完成：

- `currentConversationId / conversations / conversationMessages` 命名清理。
- conversation 列表与 visibility badge。
- hidden conversation 显示开关。
- 点击切换 conversation 并拉取 conversation stream/settings。

还需要补：

- AgentRun 列表/状态展示。
- child AgentRun 展开查看。
- child conversation 切换/打开入口。
- sub_agent 工具卡片显示 child run id / child conversation id。
- notification 的结构化展示。
- mode/model/tool/approval policy 的调试展示。

---

### 8. 存储层是可运行版，不是最终分目录版

当前为了完成大一统核心，存储已改成新的 `ClientState` 全量文件方式：

```text
<dataRoot>/client-state.json
```

这能跑通新格式，也符合“不写旧格式兼容”的方向。

但还不是最终最优结构。后续如果要完全符合架构准则，应拆成独立目录：

```text
agent-runs/
agent-run-source-links/
agent-run-target-links/
message-run-links/
tool-call-run-links/
run-policies/
message-revisions/
approval-policies/
mode-approval-policy-links/
```

当前 `RuntimePaths` 已经预留了这些 root path，但 `vscodeStorage/index.ts` 暂时没有逐类使用它们。

---

### 9. ClientSync 目前偏简单

当前 ClientSync 为了适配新 `ClientState`，采用了更保守的 snapshot 逻辑。

后续可以继续优化：

- 为 AgentRun / RunPolicy / Link 增加精细 diff patch。
- conversation stream 增量推送更细粒度。
- 减少全量 snapshot 频率。
- Webview store 支持新增 patch 类型的完整处理，而不是只处理当前 UI 需要的子集。

---

### 10. Tool approval UX 需要继续完善

后端现在通过 run-scoped `ApprovalPolicy` 决定是否需要审批。

但 UI 侧的人工审批体验还需要补：

- run-aware tool approval card。
- approval 时不再依赖 executorAgentId/executorModeId。
- `manualOnly` / `always` / `onRisk` 的交互细节。
- background run 不可交互审批时的明确处理策略。

---

### 11. AgentRun 生命周期还可以更精细

当前状态流已能跑通主路径，但后续应继续补齐：

- run cancellation。
- run stale 标记。
- run retry / regenerate。
- run pause/resume。
- parent-child run 树查询。
- 多个 child run 并行完成后的 notification 合并策略。
- run 结束原因、错误分类、usage 统计。

---

### 12. sub_agent 的复用/fork/branch 语义还需增强

当前 `sub_agent` 已是统一 AgentRun 入口，但它的参数还有一些只声明未完全实现：

```ts
conversation: {
  mode: 'fresh' | 'reuse' | 'fork' | 'same' | 'branch';
  reuseKey?: string;
  conversationId?: string;
  history?: 'none' | 'summary' | 'last_n' | 'full' | 'selected';
}
```

后续应补齐：

- `reuse`：按 key 找长期子 agent conversation。
- `fork`：从 source conversation 按 ContextPolicy 建分支。
- `branch`：按 revision 建分支。
- `conversationId`：显式指定目标 conversation。
- `history` 参数映射到 `RunContextPolicy`。

---

### 13. 命名清理

主要命名清理已完成。公共协议不再保留 `SessionRecord/sessionId/ToolApprovalMode` 旧别名；前端 store 与主要 UI 已使用 conversation 命名。

后续如果发现注释或极少量局部变量仍沿用 session 语义，可随功能开发顺手清理。

---

## 明确不做的事项

以下内容本轮已经决定不进入核心：

```text
RunChangeSet
自动 git diff
自动 workspace snapshot
自动记录文件修改
自动归因某个 run 修改了哪些文件
```

理由：

- 文件变更属于外部 workspace 状态，不是 AgentRun 核心执行事实。
- 模型需要时可以自己使用工具查询，例如 `git status`、`git diff`、`read_file`。
- 自动归因会引入非 git、大 diff、并发修改、临时文件等复杂问题。

未来如果需要，可以作为可选插件或 `RunArtifact/RunObservation` 扩展，而不是核心默认能力。

## 建议后续推进顺序

1. 完善 `ContextPolicy` 的真正摘要模型和更细粒度 source context/source tool result 注入。
2. 完善 `DeliveryPolicy` 的 transcript link/selected/full 展示和 notification 结构化展示。
3. 做 AgentRun UI 展示、parent-child run 树和 child conversation 跳转。
4. 实现 message edit / revision / rerun / branch 交互。
5. 增加 `delegate_to_agent` 入口，验证多 Agent 与 subagent 共用核心。
6. 将存储从 `client-state.json` 拆回按领域对象分目录。
7. 优化 ClientSync patch 粒度。
8. 完善审批 UX 和 background run 的不可交互策略。
