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

### 2. ConversationPolicy 只跑通了主要路径

当前结构上已经有：

```ts
RunConversationPolicy.mode:
  | 'same_conversation'
  | 'new_conversation'
  | 'reuse_conversation'
  | 'fork_conversation'
  | 'branch_from_revision'
```

但 runtime 主要跑通的是：

- 普通聊天：当前 conversation。
- `sub_agent`：fresh/new child conversation。
- `sub_agent conversation.mode='same'`：同 conversation 路径。

尚未完整实现：

- `reuse_conversation`：按 `reuseKey` 找到并复用长期 conversation。
- `fork_conversation`：从父 conversation 复制/投影指定历史到新 conversation。
- `branch_from_revision`：从某个 message revision/conversation revision 创建分支。
- conversation visibility 的完整 UI 行为。

---

### 3. ContextPolicy 还只是基础版

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

### 7. Webview UI 仍是最小适配

当前 Webview 已能通过类型检查，并适配 `conversationId` payload。

但 UI 仍保留很多旧命名：

```text
currentSessionId
sessions
sessionMessages
```

这些只是前端 store 层内部变量名，后续应统一改成：

```text
currentConversationId
conversations
conversationMessages
```

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

后端公共协议已经改为 Conversation，但部分内部变量名仍叫：

```text
sessionId
currentSessionId
sessions
removeSession
```

这些不影响编译，但会影响长期可读性。后续应统一替换为：

```text
conversationId
currentConversationId
conversations
removeConversation
```

建议单独做一轮命名清理，避免与旧模型混淆。

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

1. 完成命名清理：前端和后端内部变量从 session 改为 conversation。
2. 完整实现 `ConversationPolicy` 的 reuse/fork/branch。
3. 完整实现 `ContextPolicy` 的 selected/since/summary。
4. 完善 `DeliveryPolicy` 的 append/silent/transcript link。
5. 做 AgentRun UI 展示和 child conversation 跳转。
6. 实现 message edit / revision / rerun / branch 交互。
7. 增加 `delegate_to_agent` 入口，验证多 Agent 与 subagent 共用核心。
8. 将存储从 `client-state.json` 拆回按领域对象分目录。
9. 优化 ClientSync patch 粒度。
10. 完善审批 UX 和 background run 的不可交互策略。
