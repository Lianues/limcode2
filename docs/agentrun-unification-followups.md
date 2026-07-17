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
- `run_agent` 工具改为 ECS-managed tool，创建 child `AgentRun`。
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
- `run_agent` 的 conversation policy resolver 已支持：
  - `same` / `same_conversation`
  - `fresh` / `new` / `new_conversation`
  - `reuse` / `reuse_conversation`
  - `fork` / `fork_conversation`
  - `branch` / `branch_from_revision`
- `fork_conversation` 已支持按历史策略投影消息：`full`、`none`、`last_n`、`selected_messages`、`since_message`、`summary`（summary 为确定性文本投影，不调用 LLM 总结）。
- `branch_from_revision` 已支持从指定 `MessageRevision` 复制到该消息为止的历史，并使用指定 revision 内容替换对应消息。
- Webview MVP 增加 conversation 列表、visibility badge、hidden 显示开关与 conversation 切换。

## 尚未完整做完的事项

### 1. 多 Agent 委派入口已统一为 run_agent

核心已经能表达：

```text
AgentRunSourceLink
AgentRunTargetLink
RunDeliveryPolicy
```

现在不再新增单独的“委派工具”概念，而是统一通过：

```text
run_agent 工具
UI 手动委派按钮
Reviewer/Planner/Coder 等 Agent 显式调度入口
```

这些入口都应只是“创建 AgentRun”的薄入口，不另起一套执行核心。当前已删除旧命名，工具入口统一为 `run_agent`。

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
- agent run 参数里的 `conversation.history='selected'` 等高级策略映射。

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

这样 spawnAgentRun() 默认创建的 policy 不会覆盖后续 run_agent 写入的 run override policy。

6. 完善 run_agent 参数映射

修改：
backend/world/modules/tools/definitions/runAgent/index.ts
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
backend/world/modules/tools/definitions/runAgent/index.ts
backend/world/modules/tools/systems/ToolDispatchSystem.ts
验证结果

已执行并通过：
npm run check
没有引入自动 diff、自动 workspace snapshot、自动修改归因，仍然保持文档要求的 AgentRun 核心边界。
23:14  943.8s  ↑187,875(187,392)  ↓1,101   40.1 t/s

---

### 4. run_agent mode 全套参数还未完全落地(已完成)

`run_agent` 工具 schema 里已经暴露了完整 mode 覆盖入口：

```ts
mode: {
  workflowId?: string;
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

- `workflowId`
- `systemPromptId`
- `modelProfileId`
- `toolPolicyId`
- `approvalPolicyId`

尚未完整实现：

- `contextPolicyId`
- `deliveryPolicyId`
- `editPolicyId`
- inline 创建临时 policy 的能力。
- agent run type/blueprint 的默认 conversation/context/delivery/edit policy 全量落地。



已经完成第 4 部分 run_agent mode 全套参数 的落地，并通过：
npm run check
完成内容

1. contextPolicyId / deliveryPolicyId / editPolicyId 已支持

run_agent 现在支持：
mode: {
  contextPolicyId?: string;
  deliveryPolicyId?: string;
  editPolicyId?: string;
}
运行时会根据 id 查找已有：
RunContextPolicy
RunDeliveryPolicy
RunEditPolicy
并创建对应 active link：
RunContextPolicyLink
RunDeliveryPolicyLink
RunEditPolicyLink
仍然保持 policy 独立对象 + link 覆盖的 ECS 模型。
2. 支持 inline 临时 policy

run_agent.mode 现在支持 inline 临时策略：
mode: {
  contextPolicy?: {
    historyMode?: 'none' | 'full' | 'last_n' | 'since_message' | 'selected_messages' | 'summary';
    lastN?: number;
    sinceMessageId?: string;
    selectedMessageIds?: string[];
    includeSourceContext?: boolean;
    includeSourceToolResult?: boolean;
  };

  deliveryPolicy?: {
    mode?: 'direct_reply' | 'tool_response' | 'notification' | 'append_to_source_conversation' | 'silent';
    includeTranscript?: 'none' | 'summary' | 'selected' | 'full' | 'link';
  };

  editPolicy?: {
    onSourceEdited?: 'ignore_snapshot' | 'abort_and_restart' | 'append_correction' | 'branch_new_run' | 'mark_stale';
    onNewUserMessageWhileRunning?: 'queue_next_run' | 'interrupt_current' | 'append_to_target' | 'ignore';
  };
}
inline policy 会创建临时 run-scoped policy entity，并用 active link 绑定到 child run。

优先级是：
inline policy
  > policyId
  > run_agent shorthand 参数
  > blueprint default
  > hardcoded fallback
3. agent run blueprint 默认 policy 已落地

扩展了：
AgentBlueprint
AgentModeBlueprint
新增默认策略：
defaultConversationPolicy
defaultContextPolicy
defaultDeliveryPolicy
defaultEditPolicy
以及 mode 级覆盖：
conversationPolicy
contextPolicy
deliveryPolicy
editPolicy
内置类型已配置默认值：

main
conversation: same_conversation / visible
context: full
delivery: direct_reply / full
edit: mark_stale / queue_next_run
worker
conversation: new_conversation / collapsed
context: full
delivery: tool_response / summary
edit: mark_stale / queue_next_run
explore
conversation: new_conversation / collapsed
context: full
delivery: tool_response / summary
edit: ignore_snapshot / queue_next_run
reviewer
conversation: new_conversation / collapsed
context: full
delivery: tool_response / summary
edit: mark_stale / queue_next_run
4. conversation/context/delivery/edit 解析链已统一

run_agent 创建 child run 时现在会完整解析：
run_agent args
  > inline mode policy
  > explicit policyId
  > selected mode blueprint policy
  > agent blueprint default policy
  > hardcoded fallback
并且：

- conversation.history 仍作为 context shorthand 可用；
- delivery.mode/includeTranscript 仍作为 delivery shorthand 可用；
- run_in_background 仍能影响默认 delivery；
- blueprint 默认 conversation policy 会影响 fresh/reuse/fork/same/branch 的默认行为。
修改文件
backend/world/modules/agent/blueprints.ts
backend/world/modules/tools/definitions/runAgent/index.ts
backend/world/modules/tools/systems/ToolDispatchSystem.ts
验证

已通过：
npm run check
没有引入新的 Agent/Conversation 耦合字段，仍然通过独立 Run*Policy 和 Run*PolicyLink 表达覆盖关系。



---

### 5. DeliveryPolicy 只完成核心路径(已完成)

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



已继续完成第 5 部分 DeliveryPolicy 的后端实现，并通过：
npm run check
本轮完成内容

1. 完善 includeTranscript 语义

在 AgentRunDeliverySystem 中新增 delivery envelope / transcript 构建逻辑，支持：

- none：不附带 transcript
- summary：只附带摘要、messageCount、runId、conversationId
- link：只附带可追踪链接信息：
  - runId
  - conversationId
  - messageIds
  - runMessageIds
- selected：只内联当前 run 通过 MessageRunLink 关联的消息
- full：内联 child target conversation 的全部非 streaming messages

2. tool_response 增强

现在同步 child run 完成后，父 tool call 的 result 不再只是：
{ ok, result, runId }
而是结构化 envelope：
{
  ok: true,
  type: 'agent_run',
  status: 'completed',
  runId,
  conversationId,
  executor,
  summary,
  result,
  usage,
  transcript
}
并支持 RunDeliveryPolicy.targetToolCall 优先覆盖。

3. append_to_source_conversation 完整化

现在会向 source conversation 追加结构化 delivery message：
<agent-run-delivery>
  <type>agent_run</type>
  <status>completed</status>
  <run-id>...</run-id>
  <conversation-id>...</conversation-id>
  <executor>...</executor>
  <summary>...</summary>
  <result>...</result>
  <usage>...</usage>
  <transcript mode="...">...</transcript>
</agent-run-delivery>
并且会创建：
MessageRunLink(role='notification')
让这条追加消息可追踪到 child run。

4. notification XML 增强

notification 现在包含：

- runId
- child conversationId
- executor agent id/name
- summary
- result
- usage
- transcript

并继续保持原有行为：往 source conversation 写 notification message 后，再创建 AgentRun(kind='notification')。

5. silent 显式实现

现在 silent 是明确分支：

- 不写 tool response
- 不追加 conversation message
- 不创建 notification run
- 只把 child run 标记为 completed

6. 修正 run_agent async delivery 行为

修改了 ToolDispatchSystem：
notification
append_to_source_conversation
silent
都会被视为 async delivery mode。

因此 run_agent 使用这些 delivery mode 时，父 tool call 会立即返回 async_launched，child run 后续按 delivery policy 回流，避免父 tool call 永久卡在 executing。

修改文件
backend/world/modules/agentRun/systems/AgentRunDeliverySystem.ts
backend/world/modules/tools/systems/ToolDispatchSystem.ts
验证

已通过：
npm run check
本轮仍然没有引入自动 diff、workspace snapshot 或文件修改归因，保持 AgentRun 核心边界。


### 6. Message Revision / 编辑请求只完成数据结构（已完成）

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



已完成第 6 部分「Message Revision / 编辑请求」实现，并通过：
npm run check
本轮完成内容

1. 新增编辑协议与事件

新增 Webview → Backend 命令：
BridgeMessageType.MessageEdit = 'message.edit'
新增 payload：
interface MessageEditPayload {
  conversationId: string;
  messageId: string;
  text: string;
}
后端新增：
ChatEventType.Edit = 'chat:edit'
并已在 WebviewMessageRouter 中接入。
2. Webview 支持编辑消息

现在每条非 streaming message 都会显示「编辑」按钮。

交互：

- 点击「编辑」
- 展开 textarea
- 保存后发送 message.edit
- 取消则关闭编辑框

初版编辑文本使用 message 的 visible text；保存后后端会把 message content 更新成单个 text part。
3. 编辑后创建新 MessageRevision

新增系统：
backend/world/modules/chat/systems/MessageEditSystem.ts
编辑流程：

1. 找到目标 message。
2. 更新 Message.content。
3. 保留旧 MessageRevision。
4. 移除旧 MessageCurrentRevisionLink。
5. 创建新的：
MessageRevision(reason='edited')
MessageCurrentRevisionLink -> new revision
即：Message 本体保持当前内容，Revision 历史独立保存。
4. Run 启动时记录 AgentRunInputRevision

现在 LlmDispatchSystem 在发起 llm.start 前，会根据 ContextPolicy 选中的 message，记录当前 revision：
AgentRunInputRevision {
  run,
  conversation,
  revision
}
这样后续编辑消息时，可以判断哪些 running run 使用过旧 revision。
5. 实现 RunEditPolicy.onSourceEdited

已实现：
ignore_snapshot
mark_stale
abort_and_restart
append_correction
branch_new_run
行为摘要：

- ignore_snapshot
  - 不影响已运行中的 run。

- mark_stale
  - 将受影响 run 标记为 stale。

- abort_and_restart
  - 将旧 run 标记为 cancelled。
  - 基于旧 run target/source 创建 replacement run。

- append_correction
  - 向 run target conversation 追加 correction message。
  - 建立 MessageRunLink(role='input')。
  - 如当前无 active LLM request，则重新触发模型。

- branch_new_run
  - 创建 branch conversation。
  - 复制到被编辑 message 为止的历史。
  - 用新 revision content 替换对应 message。
  - 写入 ConversationBranchLink(kind='branch_from_revision')。
  - 创建新 AgentRun。
6. 实现 RunEditPolicy.onNewUserMessageWhileRunning

修改了 InputSystem，现在运行中收到新用户消息时会按 policy 处理：
queue_next_run
interrupt_current
append_to_target
ignore
行为摘要：

- queue_next_run
  - 创建新 message。
  - 创建 queued run，但暂不启动模型。
  - 等前一个 run 完成后由队列系统激活。

- interrupt_current
  - 当前 active run 标记为 cancelled。
  - 新 message 创建新 run 并立即启动。

- append_to_target
  - 新 message 追加到当前 active run target conversation。
  - 建立 MessageRunLink(role='input')。
  - 不创建新 run。

- ignore
  - 不创建 message，不创建 run。

新增队列系统：
backend/world/modules/agentRun/systems/AgentRunQueueSystem.ts
用于激活等待中的 queued run。
7. cancelled / stale run 不再被旧 LLM 流污染

修改：
backend/world/modules/chat/systems/LlmPollSystem.ts
如果 run 已经是：
cancelled | stale
则后续 LLM stream 的 delta/toolcall 不再写入；收到 done/error 后清理 request，并保持 run 状态不被改回 delivering/completed。
8. Webview store 补齐 revision 状态

webview/src/stores/clientStateStore.ts 现在支持：
messageRevisions
messageCurrentRevisionLinks
并处理 patch：
messageRevision.upsert/remove
messageCurrentRevisionLink.upsert/remove
修改文件
shared/protocol.ts
backend/application/WebviewMessageRouter.ts

backend/world/modules/chat/events.ts
backend/world/modules/chat/systems/InputSystem.ts
backend/world/modules/chat/systems/MessageEditSystem.ts
backend/world/modules/chat/systems/LlmDispatchSystem.ts
backend/world/modules/chat/systems/LlmPollSystem.ts
backend/world/modules/chat/systems/index.ts

backend/world/modules/agentRun/contextPolicy.ts
backend/world/modules/agentRun/queries.ts
backend/world/modules/agentRun/systems/AgentRunQueueSystem.ts
backend/world/modules/agentRun/systems/index.ts

webview/src/bridge/vscodeBridge.ts
webview/src/components/Chat.vue
webview/src/stores/clientStateStore.ts
验证

已通过：
npm run check
本轮没有引入自动 diff、workspace snapshot 或文件修改归因；仍保持 Message / Revision / Run / Policy 解耦。

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
- run_agent 工具卡片显示 child run id / child conversation id。
- notification 的结构化展示。
- mode/model/tool/approval policy 的调试展示。

---

### 8. 存储层是可运行版，不是最终分目录版(已完成)

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



第 8 部分「存储层分目录化」已完成，并通过：
npm run check
完成内容

1. 移除 client-state.json 主存储路径

原来：
<dataRoot>/client-state.json
承载所有业务数据。

现在 vscodeStorage/index.ts 不再读写这个文件，也不做旧格式 fallback。

2. 新增分目录 ClientState store

新增文件：
backend/capabilities/vscodeStorage/clientStateStore.ts
负责把 ClientState 拆成多个独立 record store 读写。

3. 结构对象按领域目录存储

现在会使用这些 root：
agents/
agent-workflows/
tool-policies/
approval-policies/
system-prompts/
model-profiles/
agent-conversation-links/
agent-mode-links/
mode-tool-policy-links/
mode-approval-policy-links/
mode-system-prompt-links/
mode-model-profile-links/
agent-runs/
agent-run-source-links/
agent-run-target-links/
message-run-links/
tool-call-run-links/
message-revisions/
run-policies/
其中 run-policies/ 内部继续按类型拆分：
run-policies/conversation-policies/
run-policies/context-policies/
run-policies/delivery-policies/
run-policies/edit-policies/
run-policies/mode-links/
run-policies/system-prompt-links/
run-policies/model-profile-links/
run-policies/tool-policy-links/
run-policies/approval-policy-links/
run-policies/conversation-policy-links/
run-policies/context-policy-links/
run-policies/delivery-policy-links/
run-policies/edit-policy-links/
4. Conversation 相关数据分片存储

Conversation 本体：
conversations/index.json
conversations/records/*.json
Messages：
conversations/messages/{conversationShard}/index.json
conversations/messages/{conversationShard}/records/*.json
ToolCall snapshots：
conversations/tool-calls/{conversationShard}/index.json
conversations/tool-calls/{conversationShard}/records/*.json
ToolCall events：
conversations/tool-call-events/{conversationShard}/index.json
conversations/tool-call-events/{conversationShard}/records/*.json
Conversation links：
conversations/reuse-links/
conversations/branch-links/
5. 增量写入不再改全量 state

这些接口现在直接写对应分片：
saveMessageSnapshot()
removeMessage()
saveToolCallSnapshot()
appendToolCallEvent()
不再执行：
load client-state.json -> 改数组 -> save client-state.json
6. loadClientState() 可从分目录重组完整投影

启动时会从各个目录读取 records，重新组装成完整 ClientState，供现有 hydration 流程继续使用。

如果所有 store 都为空，返回 undefined，让默认初始化逻辑继续创建 default Agent / Conversation。

修改文件
backend/capabilities/vscodeStorage/clientStateStore.ts
backend/capabilities/vscodeStorage/index.ts
验证

已通过：
npm run check
本轮没有加入旧 client-state.json 兼容读取，也没有引入自动 diff / workspace snapshot / 修改归因。
23:33  302.9s  ↑274,201(272,896)  ↓912   32.9 t/s
Iris 进度 · 3/3 已完成
  ✓ 新增分目录 ClientState store
  ✓ 改造 VS Code storage capability
  ✓ 验证存储类型检查

---

### 9. ClientSync 目前偏简单(已完成)

当前 ClientSync 为了适配新 `ClientState`，采用了更保守的 snapshot 逻辑。

后续可以继续优化：

- 为 AgentRun / RunPolicy / Link 增加精细 diff patch。
- conversation stream 增量推送更细粒度。
- 减少全量 snapshot 频率。
- Webview store 支持新增 patch 类型的完整处理，而不是只处理当前 UI 需要的子集。



第 9 部分 ClientSync 精细化 已完成，并通过：
npm run check
完成内容

1. ClientSync 改为 snapshot + patch 混合模式

修改：
backend/world/clientSync/systems/ClientSyncSystem.ts
之前逻辑：
只要 stream 有变化，就发 client.snapshot
现在逻辑：
首次订阅 / 显式 resync / 无 lastState
  -> client.snapshot

已有 stream 且只是增量变化
  -> client.patch
也就是说：

- global stream 不再每次全量 snapshot。
- conversation stream 不再每次全量 snapshot。
- 已有 stream 会基于 contributor diff 发送 patch。
2. 启用了已有 contributor diff

现在 ClientSyncSystem 会调用各 contributor 的 diff：
agentClientSyncContributor.diff
workflowClientSyncContributor.diff
chatClientSyncContributor.diff
toolsClientSyncContributor.diff
agentRunClientSyncContributor.diff
因此这些 patch 现在会真正被使用：
agentRun.upsert/remove
agentRunSourceLink.upsert/remove
agentRunTargetLink.upsert/remove
messageRunLink.upsert/remove
toolCallRunLink.upsert/remove
runConversationPolicy.upsert/remove
runContextPolicy.upsert/remove
runDeliveryPolicy.upsert/remove
runEditPolicy.upsert/remove
runWorkflowLink.upsert/remove
runSystemPromptLink.upsert/remove
runModelProfileLink.upsert/remove
runToolPolicyLink.upsert/remove
runApprovalPolicyLink.upsert/remove
run*PolicyLink.upsert/remove
agentRunInputRevision.upsert/remove
3. conversation stream 内容更完整

conversationClientState(...) 现在不只包含：
messages
toolCalls
toolCallEvents
还会包含与该 conversation 相关的：
agentRuns
agentRunSourceLinks
agentRunTargetLinks
messageRunLinks
toolCallRunLinks
runConversationPolicies
runContextPolicies
runDeliveryPolicies
runEditPolicies
runWorkflowLinks
runSystemPromptLinks
runModelProfileLinks
runToolPolicyLinks
runApprovalPolicyLinks
runConversationPolicyLinks
runContextPolicyLinks
runDeliveryPolicyLinks
runEditPolicyLinks
agentRunInputRevisions
过滤逻辑基于：

- 当前 conversation 的 messages
- 当前 conversation 的 toolCalls
- target conversation
- source conversation
- sourceRun parent-child 关系
- runId 关联闭包

因此 child run / parent run / run policy 信息可以进入 conversation stream 的增量同步。
4. Webview store 补齐完整 ClientState 字段

修改：
webview/src/stores/clientStateStore.ts
现在 Webview store 不再只存 UI 当前用到的一部分字段，而是补齐完整 ClientState 结构，包括：
approvalPolicies
modeApprovalPolicyLinks
conversationReuseLinks
conversationBranchLinks
messageRevisions
messageCurrentRevisionLinks
messageRunLinks
toolCallRunLinks
runConversationPolicies
runContextPolicies
runDeliveryPolicies
runEditPolicies
runWorkflowLinks
runSystemPromptLinks
runModelProfileLinks
runToolPolicyLinks
runApprovalPolicyLinks
runConversationPolicyLinks
runContextPolicyLinks
runDeliveryPolicyLinks
runEditPolicyLinks
agentRunInputRevisions
5. Webview store 支持所有 ClientPatchOp

现在 applyClientPatchOp() 已补齐所有 patch 类型处理，包括：
approvalPolicy.*
modeApprovalPolicyLink.*
conversationReuseLink.*
conversationBranchLink.*
messageRevision.*
messageCurrentRevisionLink.*
messageRunLink.*
toolCallRunLink.*
runConversationPolicy.*
runContextPolicy.*
runDeliveryPolicy.*
runEditPolicy.*
runWorkflowLink.*
runSystemPromptLink.*
runModelProfileLink.*
runToolPolicyLink.*
runApprovalPolicyLink.*
runConversationPolicyLink.*
runContextPolicyLink.*
runDeliveryPolicyLink.*
runEditPolicyLink.*
agentRunInputRevision.*
并增强了级联清理：

- conversation.remove 会清理相关 messages/toolCalls/revisions/run links。
- message.remove 会清理 revisions/currentRevisionLinks/messageRunLinks/toolCalls/events。
- agentRun.remove 会清理 run-scoped links/policies/input revisions。
修改文件
backend/world/clientSync/systems/ClientSyncSystem.ts
webview/src/stores/clientStateStore.ts
验证

已通过：
npm run check
现在第 9 部分的核心目标已经完成：

- AgentRun / RunPolicy / Link 精细 patch 已启用。
- conversation stream 支持增量 patch。
- 全量 snapshot 频率降低。
- Webview store 不再忽略大量新增 patch 类型。

---

### 10. Tool approval UX 需要继续完善

后端现在通过 run-scoped `ApprovalPolicy` 决定是否需要审批。

但 UI 侧的人工审批体验还需要补：

- run-aware tool approval card。
- approval 时不再依赖 executorAgentId/executorModeId。
- `manualOnly` / `always` / `onRisk` 的交互细节。
- background run 不可交互审批时的明确处理策略。

---

### 11. AgentRun 生命周期还可以更精细（已完成）

当前状态流已能跑通主路径，但后续应继续补齐：

- run cancellation。
- run stale 标记。
- run retry / regenerate。
- run pause/resume。
- parent-child run 树查询。
- 多个 child run 并行完成后的 notification 合并策略。
- run 结束原因、错误分类、usage 统计。


已完成第 11 部分「AgentRun 生命周期精细化」，并通过：
npm run check
完成内容

1. AgentRun 状态与记录字段增强

AgentRunStatus 新增：
'paused'
AgentRunRecord / AgentRunData 新增：
completedAt?: number;
endReason?: AgentRunEndReason;
errorType?: AgentRunErrorType;
usageMetadata?: LlmUsageMetadataRecord;
retryOfRunId?: string;
attempt?: number;
新增结束原因：
completed
failed
cancelled_by_user
cancelled_by_policy
stale_source_edited
retry_requested
regenerate_requested
新增错误类型：
llm
tool
policy
cancelled
stale
unknown
2. 新增 AgentRun lifecycle command

新增 Webview/协议命令：
agentRun.cancel
agentRun.pause
agentRun.resume
agentRun.retry
agentRun.regenerate
agentRun.markStale
payload：
{
  runId: string;
  conversationId?: string;
  reason?: string;
}
并已在 WebviewMessageRouter 中接入。
3. 新增 AgentRun lifecycle world events/system

新增：
backend/world/modules/agentRun/events.ts
backend/world/modules/agentRun/systems/AgentRunLifecycleSystem.ts
支持：

- cancel
- cancel conversation active runs
- pause
- resume
- retry
- regenerate
- mark stale
4. ChatAbort 现在会真正取消 active runs

之前 ChatAbort 只给 conversation 加 Aborted 标记。

现在会额外触发：
AgentRunEventType.CancelConversation
因此当前 conversation 中 active run 会被标记：
status = 'cancelled'
endReason = 'cancelled_by_user'
errorType = 'cancelled'
completedAt = now
并清理 active LLM request / streaming message / open tool calls。
5. pause / resume

实现语义：

pause

- run 标记为：
status = 'paused'
- 移除 AgentRunNeedsModel
- 清理 active LLM request
- 不设置 completedAt/endReason

resume

- paused run 恢复为：
status = 'running'
- 重新 markRunNeedsModel(run)
6. retry / regenerate

实现：

- 根据旧 run 的 source / target 创建新 AgentRun。
- 新 run 设置：
retryOfRunId = oldRun.id
attempt = oldRun.attempt + 1
- 复制旧 run 的 active overrides：
RunWorkflowLink
RunSystemPromptLink
RunModelProfileLink
RunToolPolicyLink
RunApprovalPolicyLink
RunConversationPolicyLink
RunContextPolicyLink
RunDeliveryPolicyLink
RunEditPolicyLink
7. cancelled / stale / paused run 不再继续被 LLM 流污染

LlmPollSystem 现在会忽略：
cancelled
stale
paused
状态 run 的后续 LLM delta/toolcall。

终止时会清理 request，并把 streaming model message 标记为 error。
8. 核心路径写入 endReason / errorType / usage

已补：

LLM error
status = 'failed'
endReason = 'failed'
errorType = 'llm'
completedAt = now
delivery complete
status = 'completed'
endReason = 'completed'
completedAt = now
usageMetadata = merged model usage
policy cancel / stale
cancelled_by_policy
stale_source_edited
user cancel
cancelled_by_user
9. parent-child run 树查询

新增查询：
parentRunForRun(world, run)
childRunsForRun(world, run)
runTree(world, root)
基于：
AgentRunSourceLink.sourceRun
没有把 children 嵌进 AgentRun。
10. notification 合并策略

AgentRunDeliverySystem 现在处理 notification 时：

- 如果 source conversation 已经有 active AgentRun(kind='notification')
  - 不再创建新的 notification run
  - 把新 notification message 通过 MessageRunLink(role='input') 绑定到已有 notification run
  - 重新 markRunNeedsModel(existingNotificationRun)

这样多个 child run 并行完成时，可以合并到已有 notification run。
修改文件
shared/protocol.ts

backend/application/WebviewMessageRouter.ts

backend/world/modules/agentRun/components.ts
backend/world/modules/agentRun/bundles.ts
backend/world/modules/agentRun/events.ts
backend/world/modules/agentRun/index.ts
backend/world/modules/agentRun/queries.ts
backend/world/modules/agentRun/systems/AgentRunLifecycleSystem.ts
backend/world/modules/agentRun/systems/AgentRunDeliverySystem.ts
backend/world/modules/agentRun/systems/index.ts

backend/world/modules/chat/systems/InputSystem.ts
backend/world/modules/chat/systems/LlmPollSystem.ts
backend/world/modules/chat/systems/MessageEditSystem.ts

backend/world/modules/tools/systems/ToolResultSystem.ts

webview/src/bridge/vscodeBridge.ts
验证

已通过：
npm run check
本轮仍然保持 AgentRun / Link / Policy 解耦，没有引入自动 workspace diff 或修改归因。

---

### 12. run_agent 的复用/fork/branch 语义还需增强(已完成)

当前 `run_agent` 已是统一 AgentRun 入口，但它的参数还有一些只声明未完全实现：

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

第 12 部分之前主路径基本已经完成，但我检查后发现还有几个边角语义没补全，所以这轮已经补上，并通过：
npm run check
已补齐内容

1. 显式 conversationId 时确保 AgentConversationLink

之前 run_agent.conversation.conversationId 可以显式指定目标 conversation，但没有保证目标 agent 和该 conversation 之间有关系数据。

现在会确保：
AgentConversationLink(targetAgent, explicitConversation, participant)
避免出现 child run 指向了 conversation，但 target agent 没有参与关系的问题。
2. conversationId + fork 现在会写 branch link

之前：
conversation: {
  mode: 'fork',
  conversationId: '...'
}
只会把历史投影复制到指定 conversation，但不会记录 fork 来源。

现在会额外写入：
ConversationBranchLink {
  sourceConversation,
  targetConversation: explicitConversation,
  kind: 'fork'
}
3. conversationId + branch 现在会写 branch link

之前：
conversation: {
  mode: 'branch',
  conversationId: '...',
  branchFromRevisionId: '...'
}
会复制 revision 历史，但不会记录 branch link。

现在会写入：
ConversationBranchLink {
  sourceConversation,
  targetConversation: explicitConversation,
  sourceRevision,
  kind: 'branch_from_revision'
}
4. reuse 命中已有 conversation 时确保 agent link

之前 reuse 命中已有 ConversationReuseLink 时会直接返回目标 conversation。

现在会额外确保：
AgentConversationLink(targetAgent, reusedConversation, default)
这样即使已有 reuse link 是旧数据或不带 agent，也能保证 target agent 与 reused conversation 的关系完整。
5. run_agent schema 补齐 history alias 说明

conversation.history 描述从：
none | summary | last_n | full | selected
更新为：
none | summary | last_n | full | selected/selected_messages | since/since_message
代码本身之前已经支持这些 alias，这次补齐了 schema 描述。

修改文件
backend/world/modules/tools/systems/ToolDispatchSystem.ts
backend/world/modules/tools/definitions/runAgent/index.ts
验证

已通过：
npm run check
所以第 12 部分现在也完成了。



---

### 13. 命名清理（已完成）

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
2. 做 AgentRun UI 展示、parent-child run 树和 child conversation 跳转。
3. 完善审批 UX 和 background run 的不可交互策略。
