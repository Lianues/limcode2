# 数据传输层注册机制样板代码分析

## 问题概述

当前新增一个实体表（如 `FileAttachment`）需要修改 **6 个文件、11 处代码**，其中大部分是机械式 copy-paste。本文档记录每一处具体修改内容，供后续优化时参考。

---

## 当前新增实体的完整改动清单

以假设新增 `FileAttachment` 为例：

### 第一层：协议定义 (`shared/protocol.ts`)

#### 修改 1：定义 Record 接口（~第 357 行附近）

```typescript
export interface FileAttachmentRecord {
  id: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  size: number;
}
```

#### 修改 2：加入 ClientState 结构体（~第 557-597 行）

```typescript
export interface ClientState {
  // ... 现有 38 个字段
  fileAttachments: FileAttachmentRecord[];  // ← 新增
}
```

#### 修改 3：加入 ClientPatchOp union（~第 599-680 行）

```typescript
export type ClientPatchOp =
  // ... 现有 82 个 variant
  | { kind: 'fileAttachment.upsert'; fileAttachment: FileAttachmentRecord }
  | { kind: 'fileAttachment.remove'; id: string };
```

---

### 第二层：后端 Contributor (`backend/world/modules/xxx/clientSync.ts`)

#### 修改 4：project 函数

```typescript
export function projectXxxClientState(world: WorldReader): ClientStateSlice {
  const fileAttachments: FileAttachmentRecord[] = world
    .query(FileAttachment, PartOf)
    .map((entity) => buildFileAttachmentRecord(world, entity))
    .filter((item): item is FileAttachmentRecord => item !== undefined);
  return { fileAttachments };
}
```

#### 修改 5：diff 函数

```typescript
export function diffXxxClientState(prev: ClientState, next: ClientState): ClientPatchOp[] {
  return diffUpsertRemove(
    prev.fileAttachments,
    next.fileAttachments,
    (fileAttachment): ClientPatchOp => ({ kind: 'fileAttachment.upsert', fileAttachment }),
    (id): ClientPatchOp => ({ kind: 'fileAttachment.remove', id })
  );
}
```

---

### 第三层：后端 ClientSyncSystem (`backend/world/clientSync/systems/ClientSyncSystem.ts`)

#### 修改 6：emptyClientState() 加字段（~第 130 行）

```typescript
function emptyClientState(): ClientState {
  return {
    // ... 现有 38 个字段
    fileAttachments: [],  // ← 新增
  };
}
```

#### 修改 7：globalClientState() 或 conversationClientState() 决定归属

如果属于 conversation 粒度（通过 messageId 关联）：

```typescript
function conversationClientState(state: ClientState, conversationId: string): ClientState {
  return {
    ...emptyClientState(),
    // ... 现有字段
    fileAttachments: state.fileAttachments.filter(a => messageIds.has(a.messageId)),  // ← 新增
  };
}
```

---

### 第四层：Worker 备选路径 (`backend/world/clientSync/worker.ts`)

#### 修改 8：又一份 emptyClientState()（~第 55 行）

```typescript
function emptyClientState(): ClientState {
  return {
    // ... 与 ClientSyncSystem.ts 完全重复
    fileAttachments: [],  // ← 新增
  };
}
```

---

### 第五层：前端 Store (`webview/src/stores/clientStateStore.ts`)

#### 修改 9：第三份 emptyClientState()（~第 381 行）

```typescript
function emptyClientState(): ClientState {
  return {
    // ... 与上面两处完全重复
    fileAttachments: [],  // ← 新增
  };
}
```

#### 修改 10：applyClientPatchOp() 加 case（~第 124-217 行的 switch）

```typescript
case 'fileAttachment.upsert': upsert(clientState.fileAttachments, patch.fileAttachment); break;
case 'fileAttachment.remove': removeById(clientState.fileAttachments, patch.id); break;
```

#### 修改 11：applyGlobalSnapshot() 或 replaceConversationState() 加赋值

```typescript
// 如果属于 global stream：
function applyGlobalSnapshot(state: ClientState): void {
  // ... 现有 36 行
  clientState.fileAttachments = state.fileAttachments;  // ← 新增
}

// 如果属于 conversation stream：
function replaceConversationState(conversationId: string, state: ClientState): void {
  // ... 现有逻辑
  clientState.fileAttachments = [...clientState.fileAttachments.filter(a => !previousMessageIds.has(a.messageId)), ...state.fileAttachments];  // ← 新增
}
```

---

## 问题根源分析

### 1. `emptyClientState()` 重复 3 次

同一个函数在以下位置独立定义，内容完全相同：
- `backend/world/clientSync/systems/ClientSyncSystem.ts:130`
- `backend/world/clientSync/worker.ts:55`
- `webview/src/stores/clientStateStore.ts:381`

**原因**：三个文件分属不同编译目标（extension host / worker / webview），无法共享运行时代码。但可以共享一个 `shared/` 目录下的工厂函数。

### 2. `ClientPatchOp` 的 upsert/remove 是机械模板

82 个 variant 中，绝大多数遵循同一模式：
```typescript
| { kind: '<table>.upsert'; <field>: <Record> }
| { kind: '<table>.remove'; id: string }
```

仅 `message.appendText`、`message.appendThought`、`message.status`、`toolcallEvent.append` 等少数几个是特殊优化操作。

### 3. `applyClientPatchOp` switch-case 与 PatchOp 1:1 对应

93 行 switch-case 中，80+ 行都是：
```typescript
case '<table>.upsert': upsert(clientState.<table>, patch.<field>); break;
case '<table>.remove': removeById(clientState.<table>, patch.id); break;
```

### 4. contributor 的 diff 函数都是同构调用

每个 contributor 的 diff 函数都是对 `diffUpsertRemove` 的机械调用：
```typescript
patches.push(...diffUpsertRemove(prev.<table>, next.<table>, upsertFactory, removeFactory));
```

---

## 可能的优化方向

### 方向 A：共享 `emptyClientState`

将 `emptyClientState()` 移到 `shared/protocol.ts` 中导出，三处改为 import。

**收益**：新增字段从改 3 处减为改 1 处。
**代价**：几乎为零。

### 方向 B：数据驱动的表注册表

定义一个 table schema 注册表：

```typescript
// shared/tableRegistry.ts
export const CLIENT_STATE_TABLES = {
  agents: { patchKind: 'agent', recordField: 'agent' },
  fileAttachments: { patchKind: 'fileAttachment', recordField: 'fileAttachment' },
  // ...
} as const;
```

然后：
- `emptyClientState()` → 从注册表 keys 自动生成
- `applyClientPatchOp()` → 泛化为查表 + upsert/removeById
- `ClientPatchOp` → 用泛型从注册表自动推导 upsert/remove variants

**收益**：新增实体从改 11 处减为改 2-3 处（注册表 + contributor）。
**代价**：需要重构 protocol.ts 的类型系统，可能影响类型推导性能。

### 方向 C：codegen

用脚本从一个 schema 文件生成 protocol.ts 中的 ClientState、ClientPatchOp、emptyClientState、applyClientPatchOp 等样板代码。

**收益**：新增实体只需改 schema 文件 + contributor。
**代价**：引入构建步骤，IDE 跳转到生成文件会稍不友好。

---

## 当前状态

- 这是 DX（开发体验）问题，不是运行时性能问题
- 当前实体表数量（38 个）已经稳定，短期内不会频繁新增
- 前端 MVP 阶段后面要重做，重做时适合一并处理
- **建议优先级：方向 A（零成本）> 方向 B（等重做时）> 方向 C（仅在表数量继续膨胀时考虑）**
