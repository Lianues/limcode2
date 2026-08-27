# Gemini 兼容测试 VSIX 使用与数据风险说明

> 日期：2026-08-27
>
> 基线：`Lianues/limcode2@7e18fb2`
>
> 用途：在正式提交 PR 前，本地验证 Gemini 工具调用兼容性。

## 1. 这个测试包改了什么

本次只修改 LLM Provider 的请求/响应边界，没有新增存储迁移、删除对话或重写历史数据的逻辑：

- OpenAI-compatible Gemini 3：读取并回传 Google/Vertex 的 `thought_signature` / `thoughtSignature`。
- 原生 Gemini：把同一批并行工具调用的连续 `functionResponse` 合并到同一个 user turn。
- 原生 Gemini：递归移除不支持的工具 JSON Schema 字段，包括 `propertyNames` 和 `multipleOf`，同时保留合法属性名与 `required`。
- 非 Gemini Provider 保持原编码路径。

`limcode-test` PR #4 中属于新 reliable-kernel 架构的 fork/attachment 投影修改没有移植，因为 `limcode2` 不存在对应模块。

## 2. 为什么仍可能出现“对话丢失”

**本补丁本身不删除对话，但测试 VSIX 不能视为零风险。** 主要风险来自安装和数据目录，而不是 Gemini 编码逻辑：

1. **扩展身份相同**
   VSIX 内部扩展 ID 是 `your-publisher.limcode`，版本仍是 `0.0.1`。使用 `--force` 安装会替换同 ID 的现有 LimCode 代码，并继续读取同一份 VS Code 扩展状态。
2. **测试包包含当前 main 的全部代码**
   它基于 `Lianues/limcode2@7e18fb2`，不只是两个 Gemini 补丁。如果当前安装包比该提交旧，测试时也会同时带入 main 上已有的存储、工作区隔离和 UI 变化。
3. **对话运行数据按 workspace 隔离**
   当前 main 把运行数据放在活动数据根的 `.limcode-workspace-runtimes/scopes/<workspace-sha256>/` 下。打开另一个文件夹、另一个 `.code-workspace`，或以不同方式打开同一项目时，可能进入另一个 scope，表现为历史对话为空；这不一定表示文件已被删除。
4. **活动数据根可能不是默认目录**
   默认数据根是 VS Code 提供的 `globalStorageUri`，但 LimCode 允许配置绝对路径作为数据目录。只备份默认目录、漏掉自定义活动数据根，无法完整回滚。
5. **多窗口/多进程共享数据根**
   正式 VS Code、测试实例或多个窗口同时指向同一数据根，会提高索引状态变化和测试互相干扰的风险。项目有进程 lease 与写入保护，但测试时仍不应主动制造共享写入。
6. **API Key 是明文数据**
   项目当前会把 LLM API Key 保存在数据根的 `settings/llm-api.json`。备份目录中可能包含密钥，不要上传或发送备份文件。

## 3. 测试前必须备份

### 3.1 找到两个位置

1. 在当前稳定版 LimCode 中执行命令：`LimCode: Reveal Data Storage Folder`。
2. 在 LimCode 全局设置中确认“活动数据目录”：
   - 未配置自定义目录：活动数据根就是上一步打开的默认 `globalStorageUri`。
   - 配置了绝对路径：该绝对路径才是主要数据根。
3. 即使使用自定义数据根，也要同时备份默认 `globalStorageUri`；全局状态仍由扩展状态和该默认目录参与管理。

### 3.2 备份方法

1. **完全关闭所有正在运行 LimCode 的 VS Code 窗口。**
2. 复制整个默认 `globalStorageUri` 目录。
3. 如果活动数据根是自定义路径，再复制整个自定义数据根。
4. 不要只复制 `conversations/`；完整备份应包含：
   - `.limcode-workspace-runtimes/`（各 workspace 的对话、消息、工具调用和运行状态）；
   - `settings/`、agents、links、runtime contexts 等共享配置；
   - 数据根中的索引、状态、锁和其他隐藏文件。
5. 为备份目录加时间戳，例如：`limcode-backup-before-gemini-test-20260827-153000`。

## 4. 推荐的隔离测试方式

最安全的方式是使用独立 VS Code user-data、独立 extensions 目录和空白 workspace，不让测试实例接触正式数据：

```powershell
$testRoot = "$env:TEMP\limcode-gemini-compat-test"
$vsix = "<替换为 VSIX 的绝对路径>"
$workspace = "$testRoot\empty-workspace"
New-Item -ItemType Directory -Force $workspace | Out-Null

code `
  --user-data-dir "$testRoot\user-data" `
  --extensions-dir "$testRoot\extensions" `
  --install-extension $vsix `
  --force

code `
  --user-data-dir "$testRoot\user-data" `
  --extensions-dir "$testRoot\extensions" `
  $workspace
```

注意：

- 隔离实例中不要把 LimCode 数据目录改回正式数据根。
- 如需验证历史对话，只复制正式数据根的备份到一个新的测试目录，再让隔离实例指向该副本。
- 不要让正式实例和隔离实例同时写同一个数据目录。

## 5. 建议测试顺序

先用新对话，最后才用历史副本：

1. **原生 Gemini schema**
   - 启用包含复杂 schema 的完整工具目录。
   - 预期不再出现 `Unknown name "propertyNames"` 或 `multipleOf` 相关 400。
2. **原生 Gemini 并行工具调用**
   - 让模型一次并行调用两个只读工具。
   - 两个工具结果返回后，预期模型能继续回答，不出现 function call/response 数量或 turn 不匹配。
3. **OpenAI-compatible Gemini 3 新对话**
   - 触发一次工具调用并继续下一轮。
   - 预期不出现 `Function call is missing a thought_signature`。
4. **OpenAI-compatible Gemini 3 历史副本**
   - 使用复制出来的旧对话测试缺签名历史。
   - 预期兼容 sentinel 只在 Gemini 3 兼容渠道边界生效，旧对话可以继续。
5. **非 Gemini 冒烟**
   - 至少验证一个普通 OpenAI-compatible 模型和一个 Claude 渠道的普通对话/工具调用。
   - 预期请求格式与原行为一致。
6. **重启与同 workspace 恢复**
   - 关闭测试实例，再以完全相同的 workspace 路径重开。
   - 确认测试对话仍可见；换 workspace 后不可见时，先检查 scope，不要立即判定数据被删除。

## 6. 出现异常时不要做什么

- 不要反复切换数据目录并让程序自动搬运同一份正式数据。
- 不要在正式版和测试版窗口同时继续发送消息。
- 不要为了“找回对话”手工编辑 `index.json`、移动单个 conversation 文件夹或合并两个备份目录。
- 不要执行 `npm audit fix --force` 后重新打包；这会把依赖升级风险混入 Gemini 测试。

## 7. 回滚步骤

1. 完全关闭所有 VS Code 窗口。
2. 卸载测试 VSIX，重新安装测试前使用的稳定 VSIX。
3. 如果只是在不同 workspace 下看不到历史，先用原 workspace 路径重开并确认活动数据根，无需立刻恢复文件。
4. 如果确认数据被修改：
   - 将当前异常数据目录另行留档；
   - 整体恢复默认 `globalStorageUri` 备份；
   - 如使用自定义数据根，再整体恢复该数据根备份；
   - 不要把备份和异常目录按文件混合覆盖。
5. 用原 workspace 路径启动稳定版并检查历史。

## 8. 当前自动化验证状态

已通过：

- `npm run compile`
- `npm run typecheck:webview`
- Gemini 定向测试：5/5
- 全量 Node 测试：369 个用例，368 passed，1 skipped，0 failed
- `git diff --check`

自动化覆盖了 schema dry-run、原生 Gemini 并行响应 turn、Google/Vertex snake_case/camelCase 签名、流式/非流式响应、历史缺签名 sentinel，以及非 Gemini 隔离。

**尚未完成真实 Gemini API 实调**：本地没有使用你的 API Key 发请求。必须以隔离实例中的人工测试结果作为提交 PR 前的最后确认。
