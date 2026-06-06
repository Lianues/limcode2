# 对话加载性能定位记录

本文记录针对“前端打开对话慢 / conversation fullLoad 过重”的定位结论、已保留的优化，以及后续仍可继续推进的性能项。

## 当前结论

### 已确认不是主要瓶颈

1. **Webview Vue 启动 / 前端渲染**
   - 生产构建下，`script.start -> app.mount.returned` 约 10~20ms。
   - `snapshot.apply` 通常约 7~16ms。
   - `messageRows.raf` 首屏通常约 80~120ms。

2. **ECS ClientSync 切片本身**
   - `conversationSlice.done` 通常 0~1ms。
   - `clientResync.conversationSnapshotRequested -> clientSync run.start` 在关闭旧 worker 空跑后约 1~2ms。

3. **VS Code Webview HTML 初始化**
   - 补过一次 inline trace，`html.set -> inline.start -> script.start` 在正常情况下为数百毫秒级。
   - 曾出现数秒级波动，但不是稳定主瓶颈。相关 inline trace 已删除。

## 已保留/完成的优化

### 1. Scheduler worker 池化并按需并行

位置：`backend/application/BackendApplication.ts`

```ts
parallelWorkers: true,
workerPoolSize: 2
```

当前已重新开启并行 worker，但前提是完成了两类修复：

1. **worker pool**
   - `Scheduler` 不再每次 system 运行都 `new Worker(...)`。
   - `SystemWorkerPool` 懒加载并复用持久 worker。
   - `SystemWorker` 支持在同一 worker 线程内接收多个 job。

2. **system 级 `shouldRun` / worker 选择**
   - `Scheduler` 会在创建 `CommandBuffer`、snapshot 和 worker job 之前先调用 `system.shouldRun(...)`。
   - `AgentSpawnSystem`：只有存在 `AgentSpawnRequest` 时运行，且不再进入 worker。
   - `ToolPollSystem`：只有收到 `ToolEventType.State` 时运行，且不再进入 worker。
   - `LlmDispatchSystem`：只有存在未 `InFlight` 的 `LlmRequest` 时才进入 worker。

原始瓶颈是：旧实现不是池化复用，而是每次 `new Worker(...)`。定位日志显示多个 worker system 经常空跑：

```text
AgentSpawnSystem commandCount=0
ToolPollSystem commandCount=0
LlmDispatchSystem commandCount=0
```

当前策略不是简单恢复旧并行，而是：普通 `client:resync` 不应触发 worker，也不应为 worker system 克隆 snapshot；只有真实 LLM dispatch 才使用 worker pool。

### 2. 首屏对话详情轻量加载

位置：

- `backend/application/BackendApplication.ts`
- `backend/capabilities/types.ts`
- `backend/capabilities/vscodeStorage/clientStateStore.ts`
- `backend/capabilities/vscodeStorage/index.ts`

普通聊天首屏只读渲染必要数据：

```ts
loadConversationDetail(conversationId, { includeRunHistory: false })
```

加载范围：

```text
messages
messageRevisions
messageCurrentRevisionLinks
toolCalls
toolCallEvents
```

`loadConversationDetail(...)` 的默认值也已改为 `includeRunHistory: false`，避免未来调用遗漏参数时意外触发 runHistory fullLoad。

### 3. 已取消普通聊天打开后的自动 runHistory fullLoad

旧行为：普通聊天打开后会延迟执行后台完整详情加载：

```ts
loadConversationDetail(conversationId, { includeRunHistory: true })
```

这会读取当前 conversation 的完整 runHistory 关联表。已观察到的数据：

```text
runCount=46
fullLoad totalRecords≈730
fullLoad duration≈1.4s~2.6s
```

当前已删除/停用：

```text
BACKGROUND_FULL_DETAIL_LOAD_DELAY_MS
loadingFullConversationDetails
scheduledFullConversationDetails
scheduleConversationDetailFullLoad(...)
ensureConversationDetailFullyLoadedInBackground(...)
```

新的普通聊天路径：

```text
打开聊天面板：只加载 render detail
打开 run history / 调试详情：通过独立 runHistory.page/detail API 按需读取
```

### 4. render detail 与 runHistory 持久化已解耦

位置：

- `backend/application/BackendApplication.ts`
- `backend/application/ClientStatePersistence.ts`
- `backend/capabilities/types.ts`
- `backend/capabilities/vscodeStorage/clientStateStore.ts`
- `backend/capabilities/vscodeStorage/index.ts`

加载状态拆为：

```ts
renderLoadedConversationDetails: Set<string>
runHistoryLoadedConversationDetails: Set<string>
```

存储写接口拆为：

```ts
saveConversationRenderDetail(conversationId, state)
saveConversationRunHistory(conversationId, state, { mode: 'merge' | 'replace' })
```

保存规则：

- render detail：只保存 messages / revisions / currentRevisionLinks / toolCalls / toolCallEvents。
- runHistory `replace`：仅用于已完整加载 runHistory 的 conversation，可重写 conversation 内 runHistory index/pages。
- runHistory `merge`：用于未加载旧 runHistory 但当前 world 产生了新/活跃 run 的 conversation，只 upsert 当前已知 run 详情，并把概要合并进既有 index/pages，不删除旧 run。

因此，取消自动 fullLoad 后：

```text
只加载聊天渲染详情 -> 消息与工具调用仍可安全持久化
未加载旧 runHistory -> 新产生的 runHistory 仍可 merge 保存，不覆盖旧 runHistory index/pages
```

### 5. runHistory 显式按需分页加载与单 run 详情

位置：

- `shared/protocol.ts`
- `backend/application/WebviewMessageRouter.ts`
- `backend/capabilities/types.ts`
- `backend/capabilities/vscodeStorage/clientStateStore.ts`
- `backend/capabilities/vscodeStorage/index.ts`
- `webview/src/stores/useRunHistoryStore.ts`
- `webview/src/composables/useBridgeBootstrap.ts`

新增独立桥接消息：

```text
runHistory.page.get -> runHistory.page.snapshot
runHistory.detail.get -> runHistory.detail.snapshot
```

列表页只返回概要，不把 runHistory 塞回普通聊天 snapshot：

```ts
loadConversationRunHistoryPage({
  conversationId,
  cursor,
  limit: 20
})
```

概要字段包括：

```text
run id
kind
status
createdAt
updatedAt
source/target 简要信息
input/output/toolCall 数量
inputPreview / outputPreview
```

点击单个 run 后，再加载详细数据：

```ts
loadConversationRunDetail({ conversationId, runId })
```

返回独立 `ConversationRunDetailRecord`，其中 `state` 是单 run 范围的 `ClientState` 子集，包含：

```text
agentRun
source/target links
messageRunLinks / toolCallRunLinks
run policies 与 policy links
agentRunInputRevisions
相关 messages / messageRevisions / toolCalls / toolCallEvents
```

前端已新增 `useRunHistoryStore`，未来 run history / 调试 UI 可直接调用 `requestPage(...)` 和 `requestDetail(...)`。

### 6. runHistory 存储布局优化

runHistory 已从“全局大量小 record + conversation run id index”改为“run 详情 canonical + conversation 索引视图”的布局：

```text
run-history/
  runs/{runSlugHash}.json                         # 单 run canonical 详情，不归属于 conversation
  conversations/{conversationSlugHash}/
    index.json                                    # 当前 conversation 的 summary index
    pages/000000.json                             # 默认 20 条 summary 一页
    pages/000001.json
```

`conversationId` 只用于“按某个 conversation 查看 run history”的索引/查询上下文；单 run 详情以 `runId` 为 canonical key，Agent/Conversation 关系仍由 `AgentRunTargetLink`、`AgentRunSourceLink`、`MessageRunLink`、`ToolCallRunLink` 等 link 表达。

读取策略：

```text
打开聊天：不读 run-history
打开 run history 列表：只读 index + 当前 page
点击单 run：通过 runId 只读 canonical run detail 文件，并校验它与当前 conversation 的 link/summary 关系
显式完整 runHistory：按 index 读取所有 run detail（不进入普通聊天路径）
```

这个布局直接服务后续调试 UI：列表页轻、单 run 详情精确读取，同时避免普通聊天路径因为历史 run 数量线性变慢。

## 后续仍可继续优化

### P2：进一步优化 runHistory 存储细节

当前已经避免普通聊天读取 runHistory，并将列表/详情拆成 page/detail。后续如超长对话 run 数量继续增长，可再考虑：

1. 按月份/天拆分 run detail 目录；
2. 最近 N 条 run 的热索引；
3. 对 detail 文件做按阶段拆分（prompt / tool / response）；
4. 显式完整 runHistory 加载时限制并发。

### P3：启动 skeleton 读取优化

启动 skeleton 当前通常为数百毫秒级。它不是本轮首屏对话慢的主因，但后续可以继续优化：

- 缓存 index；
- 合并小的全局 skeleton record；
- 避免启动时读取非必要全局表。

## 当前建议保留的状态

```text
parallelWorkers: true + worker pool + shouldRun
仅 LlmDispatchSystem 进入 worker
普通聊天首屏 includeRunHistory: false
普通聊天打开后不再自动 includeRunHistory: true
render detail 与 runHistory 分离持久化
partial runHistory 使用 merge 保存，不覆盖旧 runHistory index/pages
runHistory 列表/详情通过独立 API 按需读取
runHistory 存储为 conversation 内 index/pages/run detail 布局
```
