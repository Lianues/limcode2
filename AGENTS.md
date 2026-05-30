# AGENT.md

本文件是本项目后续开发时 AI Agent / 开发者需要遵守的架构准则。重点是：**ECS 数据、协议、effect、存储都要保持领域对象解耦**。当前准则来自 Agent 与 Conversation 解耦改造经验。

## 1. 总原则

### 1.1 独立领域对象必须独立建模

如果两个概念可以独立存在、独立复用、独立存储，就不要把一个塞进另一个对象里。

当前项目中的典型例子：

```text
Agent 是独立对象
Conversation / Session 是独立对象
Message 是独立对象
AgentConversationLink 是独立关系对象
```

不要设计成：

```text
Agent owns Conversation
Conversation embeds Agent
SessionRecord.agentId 强制绑定 Agent
```

应该设计成：

```text
Agent Entity
  - Agent
  - AgentKind
  - ModelProfile
  - ToolPolicy
  - SystemPrompt
  - AgentStatus

Conversation / Session Entity
  - Session

Message Entity
  - Message
  - PartOf -> Conversation

Link Entity
  - AgentConversationLink { agent, conversation, role }
```

### 1.2 关系也必须是数据

两个领域对象之间的关系不能藏在对象内部，也不能写死在 system 逻辑里。关系本身应作为独立 ECS 数据存在。

例如：

```ts
AgentConversationLink {
  agent: Entity;
  conversation: Entity;
  role: 'active' | 'participant' | 'reviewer';
}
```

这样切换 agent、切换 conversation、多 agent 协作，本质上都是修改 link 数据。

## 2. ECS 开发准则

### 2.1 Component 表达单一事实

每个 component 应只表达一个清晰事实。推荐：

```text
Agent
ModelProfile
ToolPolicy
SystemPrompt
Session
Message
PartOf
AgentConversationLink
```

避免创建包含多个领域概念的大组件。

### 2.2 Link 优先于嵌套字段

当 A 与 B 的关系未来可能变化，或可能变成一对多 / 多对多时，必须优先使用 Link component/entity。

推荐：

```ts
AgentConversationLink { agent, conversation, role }
```

避免：

```ts
Session { id, agentId }
Agent { id, currentSessionId }
```

### 2.3 System 解释数据，不制造耦合

System 可以读取 link 并执行行为，但不能假设某个领域对象天然拥有另一个领域对象。

推荐流程：

```text
LlmDispatchSystem
  1. 找到 NeedsResponse 的 conversation
  2. 通过 AgentConversationLink 找 active agent
  3. 读取 agent 的 ModelProfile / SystemPrompt / ToolPolicy
  4. 读取 conversation 的 messages
  5. 发出 llm.start effect
```

避免：

```text
LlmDispatchSystem 假设 Session 一定 OwnedByAgent
```

## 3. Protocol / ClientState 准则

前端协议不能把后端已经拆开的对象重新耦合起来。

推荐：

```ts
interface ClientState {
  agents: AgentRecord[];
  sessions: SessionRecord[];
  agentConversationLinks: AgentConversationLinkRecord[];
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
}
```

避免：

```ts
interface SessionRecord {
  id: string;
  agentId: string;
}
```

如果新增独立对象，也应新增独立 patch：

```ts
{ kind: 'agentConversationLink.upsert'; link }
{ kind: 'agentConversationLink.remove'; id }
```

不要为了更新 link 而重发 agent 或 session。

## 4. Effect 层准则

### 4.1 Effect payload 不应长期携带领域耦合结构

Effect 是 system 到 runtime capability 的边界。这个边界也必须保持解耦。

推荐：

```text
llm.start effect 接收：
  - model settings
  - prompt messages
  - tools
```

这些数据可以由 system 根据 ECS link 临时组装，但 effect 不应该保存类似 `agentWithConversation` 的耦合结构。

### 4.2 Effect handler 只执行外部能力

Effect handler 不应承载领域关系规则。领域关系应在 ECS world 中由 component/link 表达，由 system 解释。

例如：

```text
LlmDispatchSystem 决定哪个 agent 使用哪个 conversation
LLM capability 只负责调用模型
Storage capability 只负责读写当前投影数据
```

## 5. Storage 层准则

### 5.1 文件层也必须解耦

如果 ECS 和协议层已经拆成独立对象，存储层不能再把它们塞回一个文件或一个强绑定目录。

推荐结构：

```text
<globalStorage>/
  agents/
    index.json
    records/{timeSlugHash}.json

  conversations/
    index.json
    {timeSlugHash}/
      conversation.json
      messages/
        index.json
        chunks/000000.json

  agent-conversation-links/
    index.json
    records/{timeSlugHash}.json
```

含义：

```text
agents/ 只保存 agent 数据
conversations/ 只保存 conversation 与 message 数据
agent-conversation-links/ 只保存 agent 与 conversation 的关系
```

避免：

```text
chat/manifest.json 同时保存 agents、sessions、links
conversation 文件夹里保存 agent 配置
agent 文件夹里保存 conversation 历史
```

### 5.2 Index 只描述本类对象

每类数据的 index 只索引本类对象：

```text
agents/index.json 只列 agent records
conversations/index.json 只列 conversation records
agent-conversation-links/index.json 只列 link records
```

不要跨领域混存。

### 5.3 文件名必须可读、可排序、稳定

新记录文件名使用：

```text
{yyyyMMdd-HHmmss-SSS}-{可读slug}-{短hash}
```

例如：

```text
20260530-142233-123-main-0ab12cd.json
20260530-142240-456-default-1x9k2p3/
```

规则：

```text
1. 新记录生成 time + slug + hash 名称
2. 已存在记录复用 index 中的 file/folder
3. 未发布阶段不写旧格式兼容或迁移代码
```

## 6. 默认初始化准则

默认初始化可以为了跑通基础体验创建默认对象，但也必须遵循解耦模型。

推荐：

```text
创建 default Agent
创建 default Conversation
创建 AgentConversationLink(default Agent, default Conversation, active)
```

避免：

```text
创建 Agent 时把 Conversation 内嵌进去
创建 Session 时必须写 agentId
```

## 7. 新功能设计检查清单

新增模块、组件、effect、协议或存储格式前，必须检查：

```text
1. 这个字段是不是其实在表达另一个领域对象？
2. 这个关系未来是否可能一对多或多对多？
3. 切换关系是否能只改 link，而不用改主体对象？
4. ClientState 是否把独立对象重新塞进另一个对象？
5. Effect payload 是否携带了长期领域关系？
6. 存储文件是否把多个独立对象混在一个文件或目录里？
7. 是否为了未发布的旧格式写了兼容/迁移代码？如果没有发布，应该删除。
```

如果发现耦合，优先拆成：

```text
主体对象 A
主体对象 B
Link / Relation 对象
System 解释 Link
Effect 执行外部能力
Storage 分目录持久化
```

## 8. 当前 Agent / Conversation 案例

当前目标结构：

```text
ECS:
  Agent 独立
  Conversation / Session 独立
  Message 属于 Conversation
  AgentConversationLink 独立表达关系

Protocol:
  agents[]
  sessions[]
  messages[]
  toolCalls[]
  agentConversationLinks[]

Storage:
  agents/
  conversations/
  agent-conversation-links/

System:
  InputSystem 写入 conversation message
  LlmDispatchSystem 通过 AgentConversationLink 找 active agent
  LlmPollSystem 写回 assistant message
```

这套方式后续应用于所有类似模块：只要两个概念可以被不同功能复用，就不要做所有权绑定，而是通过独立 link 和 system 组合。
