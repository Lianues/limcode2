# 全局设置与配置项数据对接规范

> 在新增任何“设置项 / 配置页 / 可复用配置记录”前，先读本文件，再改协议、存储和前端。

## 1. 先拆两个 scope

新增配置项时不要一上来新建一套独立 BridgeMessageType / Bridge / 顶层存储目录。先判断两个 scope：

### 1.1 配置管理 scope

配置入口属于哪一级设置页：

- `global`：全局设置页，使用 `GLOBAL_SETTINGS_SECTIONS` + `GlobalSettingsBridge` + `settings.global.get/update/snapshot`。
- `conversation`：对话设置页，使用 conversation settings 的 section 与 bridge。
- `agent`：后续如有 Agent 设置页，再按 agent settings scope 扩展。

如果配置入口在全局设置页，就应优先作为 GlobalSettings 的 section，而不是新增独立消息类型。

### 1.2 配置数据 scope

配置值本身是哪种数据：

- 简单设置：一个 section 文件即可，例如 `settings/llm.json` 保存当前激活配置 id。
- 可复用配置集合：仍属于对应 settings scope，但每条配置独立成 record，并用 index 管理，例如 `settings/llm-provider-configs/index.json` + `records/*.json`。
- 真正脱离设置页、参与 ECS/ClientState 的领域对象：才按 ECS 独立对象建模，放入 ClientState / patch / 独立 storage root，并用 Link 表达关系。

## 2. 全局设置新增 section 的标准做法

新增全局配置时优先复用现有通道：

```ts
GLOBAL_SETTINGS_SECTIONS = ['common', 'llm', 'yourSection'] as const;
BridgeMessageType.GlobalSettingsGet
BridgeMessageType.GlobalSettingsUpdate
BridgeMessageType.GlobalSettingsSnapshot
```

不要为全局设置页里的 CRUD 操作新建：

```text
settings.yourThing.create
settings.yourThing.update
settings.yourThing.delete
YourThingBridge
<dataRoot>/your-thing/
```

除非它已经被确认是独立领域对象，而不只是“全局设置中的可复用配置”。

## 3. 可复用配置集合的存储标准

如果一个全局设置 section 里有多个“配置页”，每个配置页应独立存储为 record：

```text
<dataRoot>/
  settings/
    your-active-section.json
    your-configs/
      index.json
      records/
        {yyyyMMdd-HHmmss-SSS}-{slug}-{hash}.json
```

要求：

1. 每个 record 是一个配置对象。
2. `index.json` 只索引本集合的 record。
3. 当前激活 id 这类“选择关系/状态”不要塞进每个配置 record；单独放在对应 settings section 中。
4. 读写路径必须通过 storage capability 内部 `getPaths()` 获取，业务数据写在 `paths.settingsRootUri` 下。
5. 前端保存仍走 `GlobalSettingsUpdate`，后端在 `saveGlobalSettings(section, settings)` 内分发到对应存储实现。

## 4. LLM 渠道配置示例

当前 LLM 渠道配置采用两个 global settings section：

```text
llm:
  activeProviderConfigId: string

llmProviderConfigs:
  configs: LlmProviderConfigRecord[]
```

文件结构：

```text
<dataRoot>/settings/llm.json
<dataRoot>/settings/llm-provider-configs/index.json
<dataRoot>/settings/llm-provider-configs/records/*.json
```

运行时读取：

```ts
storage.loadActiveLlmProviderConfig()
```

这样 LLM capability 只拿当前激活的模型连接配置；未来 Agent / Workflow / 其他对象如需复用某个渠道，应通过独立 Link/关系数据引用配置 id，不要把渠道配置嵌进 Agent 或 Conversation。

## 5. 前端对接标准

1. 页面组件不要直接调用 bridge，统一通过对应 Pinia store action。
2. 全局设置页签只处理展示与交互；数据请求/保存收口在 `useGlobalSettingsStore`。
3. 下拉选择控件优先复用 `webview/src/components/settings/global/SettingsDropdown.vue`（基于 `project-dropdown` + `lc-dropdown-panel` + `IconCaretUp`），不要使用浏览器原生 select 造成风格不一致。
4. 下拉内容可能溢出时必须复用 `webview/src/components/navigation/AdvancedScrollbar.vue`；SettingsDropdown 已内置 `variant="minimal"` 基础滑块样式，并支持 `maxHeight` / `height`。
5. 删除/危险确认必须复用 `webview/src/components/ui/ConfirmPanel.vue`。
6. 需要输入名称/重命名时优先复用 `webview/src/components/ui/InputPanel.vue`。

## 6. 后端对接检查清单

新增配置项前确认：

```text
1. 这是 global/conversation/agent 哪个配置管理 scope？
2. 它是简单设置，还是同一 scope 下的可复用 record 集合？
3. 如果只是全局设置 section，是否复用了 GlobalSettingsGet/Update/Snapshot？
4. 如果是可复用集合，是否在 settingsRootUri 下用 index + records 存储？
5. 是否避免了为设置页 CRUD 新建 BridgeMessageType / Bridge？
6. 如果未来需要被 Agent/Workflow 等引用，是否计划用 Link 存 id，而不是嵌入配置对象？
7. 是否通过 getPaths() 获取路径？
```
